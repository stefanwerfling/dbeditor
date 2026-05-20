import {ExtractSchemaResultType, SchemaErrors, Vts} from 'vts';
import {AddProjectError} from './AddProjectError.js';
import {Config, ConfigDialect, ConfigOutputMode, SchemaConfig} from './Config.js';

export {AddProjectError} from './AddProjectError.js';
export type {AddProjectErrorCode} from './AddProjectError.js';

/**
 * Body accepted by the "add new project to dbeditor.json" route.
 *
 * Mirrors the user-visible required fields of `SchemaConfigProject` but
 * with a flatter, smaller surface: callers may omit anything that has a
 * sensible default (e.g. `destinationClear`, `sqlIndent`). The route's
 * sister UI dialog collects exactly these fields.
 */
export const SchemaAddProjectInput = Vts.object({
    name: Vts.string(),
    schemaPath: Vts.string(),
    dialect: Vts.string(),
    output: Vts.object({
        mode: Vts.string(),
        destinationPath: Vts.string()
    }),
    autoGenerate: Vts.optional(Vts.boolean())
});

export type AddProjectInput = ExtractSchemaResultType<typeof SchemaAddProjectInput>;

/**
 * Body accepted by the "edit existing project" route. Every field is
 * optional — omitted fields keep their current value on disk. `output`
 * is patched at sub-field granularity (you can change just the `mode`
 * without re-supplying `destinationPath`).
 *
 * NB: this only edits the dbeditor.json diagram. Output overrides written
 * to the schema file by `ProjectSettingsDialog` continue to take
 * precedence at runtime via `repo.effectiveOutput()`.
 */
export const SchemaUpdateProjectInput = Vts.object({
    name: Vts.optional(Vts.string()),
    schemaPath: Vts.optional(Vts.string()),
    dialect: Vts.optional(Vts.string()),
    output: Vts.optional(Vts.object({
        mode: Vts.optional(Vts.string()),
        destinationPath: Vts.optional(Vts.string())
    })),
    autoGenerate: Vts.optional(Vts.boolean())
});

export type UpdateProjectInput = ExtractSchemaResultType<typeof SchemaUpdateProjectInput>;

const KNOWN_DIALECTS: Set<string> = new Set(Object.values(ConfigDialect));
const KNOWN_OUTPUT_MODES: Set<string> = new Set(Object.values(ConfigOutputMode));

export class ProjectConfig {

    private static _validateConfig(rawConfig: unknown): Config {
        const cfgErrors: SchemaErrors = [];
        if (!SchemaConfig.validate(rawConfig, cfgErrors)) {
            throw new AddProjectError(
                'invalid-config',
                'dbeditor.json failed validation',
                cfgErrors.map(e => String(e))
            );
        }
        return rawConfig as Config;
    }

    private static _revalidateMerged(nextConfig: Config): void {
        const merged: SchemaErrors = [];
        if (!SchemaConfig.validate(nextConfig, merged)) {
            throw new AddProjectError(
                'invalid-config',
                'merged dbeditor.json failed validation',
                merged.map(e => String(e))
            );
        }
    }

    /**
     * Pure logic for adding a new project to a dbeditor.json config object.
     *
     * Takes a parsed-but-otherwise-unvalidated config object plus an
     * already-shape-validated `AddProjectInput`, returns the merged config
     * with the new entry appended. Throws `AddProjectError` on any
     * structural problem so the calling route can map to an HTTP status.
     *
     * Side-effect free — the caller owns the file IO and the server restart.
     */
    public static add(rawConfig: unknown, input: AddProjectInput): Config {
        const config = ProjectConfig._validateConfig(rawConfig);

        const name = input.name.trim();
        if (name === '') {
            throw new AddProjectError('invalid-input', 'name is required');
        }
        const schemaPath = input.schemaPath.trim();
        if (schemaPath === '') {
            throw new AddProjectError('invalid-input', 'schemaPath is required');
        }
        const dialect = input.dialect.trim();
        if (!KNOWN_DIALECTS.has(dialect)) {
            throw new AddProjectError(
                'invalid-input',
                `unknown dialect "${dialect}" — must be one of ${[...KNOWN_DIALECTS].join(', ')}`
            );
        }
        const mode = input.output.mode.trim();
        if (!KNOWN_OUTPUT_MODES.has(mode)) {
            throw new AddProjectError(
                'invalid-input',
                `unknown output mode "${mode}" — must be one of ${[...KNOWN_OUTPUT_MODES].join(', ')}`
            );
        }
        const destinationPath = input.output.destinationPath.trim();
        if (destinationPath === '') {
            throw new AddProjectError('invalid-input', 'output.destinationPath is required');
        }

        /*
         * Uniqueness is enforced on both `name` (display-level — otherwise
         * the treeview shows two indistinguishable roots) and `schemaPath`
         * (data-level — two projects sharing one schema file would
         * corrupt each other on flush). The check is case-insensitive on
         * name only; paths are intentionally case-sensitive because
         * Linux filesystems are.
         */
        const lowerName = name.toLowerCase();
        for (const p of config.projects) {
            if ((p.name ?? '').toLowerCase() === lowerName) {
                throw new AddProjectError('duplicate-name', `a project named "${name}" already exists`);
            }
            if (p.schemaPath === schemaPath) {
                throw new AddProjectError(
                    'duplicate-schema-path',
                    `schemaPath "${schemaPath}" is already used by project "${p.name ?? '(unnamed)'}"`
                );
            }
        }

        const newProject = {
            name: name,
            schemaPath: schemaPath,
            dialect: dialect,
            output: {
                mode: mode,
                destinationPath: destinationPath
            },
            ...input.autoGenerate === true ? {autoGenerate: true} : {}
        };

        const nextConfig: Config = {
            ...config,
            projects: [...config.projects, newProject]
        };

        ProjectConfig._revalidateMerged(nextConfig);
        return nextConfig;
    }

    /**
     * Pure logic for patching an existing project in dbeditor.json.
     *
     * Looks up the project by its *current* name (case-insensitive) and
     * returns a config with the matched entry's fields updated according
     * to the patch. Same field validation as `add`: name uniqueness,
     * schemaPath uniqueness, dialect/mode enum membership. Uniqueness
     * checks ignore the current entry so renaming "Foo" to "FOO" or
     * keeping the schemaPath unchanged are valid no-ops.
     */
    public static update(rawConfig: unknown, projectName: string, patch: UpdateProjectInput): Config {
        const config = ProjectConfig._validateConfig(rawConfig);

        const lowerLookup = projectName.toLowerCase();
        const idx = config.projects.findIndex(p => (p.name ?? '').toLowerCase() === lowerLookup);
        if (idx < 0) {
            throw new AddProjectError('unknown-project', `no project named "${projectName}" in dbeditor.json`);
        }
        const current = config.projects[idx];

        /*
         * Patched fields: only apply if the caller supplied them and they
         * pass the same validation rules as on add. Empty-after-trim is
         * treated as "missing" — we deliberately don't accept clearing a
         * required field via PATCH (the user should use the explicit
         * remove-project flow if they want to drop the project).
         */
        let nextName = current.name ?? '';
        if (patch.name !== undefined) {
            const trimmed = patch.name.trim();
            if (trimmed === '') {
                throw new AddProjectError('invalid-input', 'name cannot be cleared');
            }
            nextName = trimmed;
        }

        let nextSchemaPath = current.schemaPath;
        if (patch.schemaPath !== undefined) {
            const trimmed = patch.schemaPath.trim();
            if (trimmed === '') {
                throw new AddProjectError('invalid-input', 'schemaPath cannot be cleared');
            }
            nextSchemaPath = trimmed;
        }

        let nextDialect = String(current.dialect);
        if (patch.dialect !== undefined) {
            const d = patch.dialect.trim();
            if (!KNOWN_DIALECTS.has(d)) {
                throw new AddProjectError(
                    'invalid-input',
                    `unknown dialect "${d}" — must be one of ${[...KNOWN_DIALECTS].join(', ')}`
                );
            }
            nextDialect = d;
        }

        let nextMode = String(current.output.mode);
        let nextDestPath = current.output.destinationPath;
        if (patch.output !== undefined) {
            if (patch.output.mode !== undefined) {
                const m = patch.output.mode.trim();
                if (!KNOWN_OUTPUT_MODES.has(m)) {
                    throw new AddProjectError(
                        'invalid-input',
                        `unknown output mode "${m}" — must be one of ${[...KNOWN_OUTPUT_MODES].join(', ')}`
                    );
                }
                nextMode = m;
            }
            if (patch.output.destinationPath !== undefined) {
                const dest = patch.output.destinationPath.trim();
                if (dest === '') {
                    throw new AddProjectError('invalid-input', 'output.destinationPath cannot be cleared');
                }
                nextDestPath = dest;
            }
        }

        /*
         * Uniqueness checks against *other* projects only — the current
         * entry is allowed to keep its own name / schemaPath. Case
         * convention matches `add`: name = insensitive,
         * schemaPath = sensitive.
         */
        const lowerNew = nextName.toLowerCase();
        for (let i = 0; i < config.projects.length; i++) {
            if (i === idx) {continue;}
            const other = config.projects[i];
            if ((other.name ?? '').toLowerCase() === lowerNew) {
                throw new AddProjectError('duplicate-name', `a project named "${nextName}" already exists`);
            }
            if (other.schemaPath === nextSchemaPath) {
                throw new AddProjectError(
                    'duplicate-schema-path',
                    `schemaPath "${nextSchemaPath}" is already used by project "${other.name ?? '(unnamed)'}"`
                );
            }
        }

        /*
         * Reconstruct the project with key order matching how `add`
         * writes them, so subsequent renames don't reshuffle the file.
         * Carry forward all the fields we don't touch (connections, sync,
         * scripts, output's optional secondaries) verbatim.
         */
        const patchedProject: any = {
            name: nextName,
            schemaPath: nextSchemaPath,
            dialect: nextDialect,
            output: {
                ...current.output,
                mode: nextMode,
                destinationPath: nextDestPath
            }
        };
        /* Preserve any fields we don't manage here (scripts, connections, sync). */
        for (const key of Object.keys(current)) {
            if (!(key in patchedProject)) {
                patchedProject[key] = (current as any)[key];
            }
        }
        if (patch.autoGenerate !== undefined) {
            if (patch.autoGenerate) {
                patchedProject.autoGenerate = true;
            } else {
                delete patchedProject.autoGenerate;
            }
        }

        const nextProjects = config.projects.map((p, i) => i === idx ? patchedProject : p);
        const nextConfig: Config = {...config, projects: nextProjects};
        ProjectConfig._revalidateMerged(nextConfig);
        return nextConfig;
    }

    /**
     * Pure logic for removing a project from dbeditor.json.
     *
     * Looks up by name (case-insensitive). Returns the merged config with
     * that single entry dropped — everything else is preserved verbatim,
     * including `server`, `browser`, and the other projects. Throws
     * `unknown-project` when the name doesn't resolve.
     *
     * Side-effect free: the on-disk schema file (`schemaPath`) is NOT
     * touched. Removing a project drops only its entry from dbeditor.json
     * — the user can re-add later by pointing at the same path. The
     * calling route surface should make this non-destructiveness obvious
     * in the confirm dialog.
     */
    public static remove(rawConfig: unknown, projectName: string): Config {
        const config = ProjectConfig._validateConfig(rawConfig);
        const lowerLookup = projectName.toLowerCase();
        const idx = config.projects.findIndex(p => (p.name ?? '').toLowerCase() === lowerLookup);
        if (idx < 0) {
            throw new AddProjectError('unknown-project', `no project named "${projectName}" in dbeditor.json`);
        }
        const nextProjects = config.projects.filter((_, i) => i !== idx);
        const nextConfig: Config = {...config, projects: nextProjects};
        /*
         * Re-validate even though we only dropped entries — the schema
         * allows empty `projects: []` (no `minItems` constraint), but
         * tightening it later should fail here, not at next server boot.
         */
        ProjectConfig._revalidateMerged(nextConfig);
        return nextConfig;
    }

}