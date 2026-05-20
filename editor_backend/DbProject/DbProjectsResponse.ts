import {ExtractSchemaResultType, Vts} from 'vts';
import {SchemaJsonDataDB, SchemaJsonEditorSettings} from '../../DbEditor/JsonData.js';

/**
 * Project summary returned to the frontend on /api/load-schema.
 * (Only fields the UI needs; secrets and absolute paths stay on the server.)
 */
export const SchemaDbProjectSummary = Vts.object({
    unid: Vts.string(),
    name: Vts.string(),
    dialect: Vts.string(),
    outputMode: Vts.string(),
    autoGenerate: Vts.boolean(),
    rev: Vts.number(),
    data: SchemaJsonDataDB,
    editor: SchemaJsonEditorSettings
});

export type DbProjectSummary = ExtractSchemaResultType<typeof SchemaDbProjectSummary>;

export const SchemaLoadSchemaResponse = Vts.object({
    projects: Vts.array(SchemaDbProjectSummary)
});

export type LoadSchemaResponse = ExtractSchemaResultType<typeof SchemaLoadSchemaResponse>;