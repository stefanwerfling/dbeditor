import {SchemaDescription} from 'vts';

/**
 * JSON Schema (draft-7) shape. We only generate the subset required by
 * MCP tool inputs — object / string / number / boolean / array with
 * `anyOf` combinators — so keep this union small rather than importing a
 * heavyweight JSON-Schema type library.
 */
export type JsonSchemaNode = {
    type?: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'null';
    description?: string;
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchemaNode;
    anyOf?: JsonSchemaNode[];
};

/**
 * Runtime shape of VTS `.describe()` output. VTS types each schema's
 * description with a different interface, but at the call site we walk
 * it generically, so model it as the full superset of fields we care
 * about.
 */
type VtsDesc = SchemaDescription & {
    type?: string;
    optional?: boolean;
    items?: Record<string, VtsDesc> | VtsDesc;
    values?: VtsDesc[];
};

/**
 * Convert a VTS schema's `.describe()` output to a JSON Schema fragment
 * suitable for an MCP tool's advertised `inputSchema`.
 *
 * Supports `object`, `string`, `number`, `boolean`, `null`, `array`,
 * `or`, `optional` and `unknown` — the set actually used by MCP tool
 * inputs in this project. Unknown leaf types fall through to an empty
 * schema (accepts anything) rather than raising, so extending a tool
 * input with a less-common VTS type degrades gracefully.
 */
export class VtsJsonSchema {

    public static convert(desc: VtsDesc): JsonSchemaNode {
        const out: JsonSchemaNode = {};

        if (desc.description !== undefined) {
            out.description = desc.description;
        }

        switch (desc.type) {
            case 'string':
            case 'number':
            case 'boolean':
            case 'null':
                out.type = desc.type;
                break;

            case 'array':
                out.type = 'array';
                if (desc.items !== undefined) {
                    out.items = VtsJsonSchema.convert(desc.items as VtsDesc);
                }
                break;

            case 'object': {
                out.type = 'object';
                out.additionalProperties = false;

                const props: Record<string, JsonSchemaNode> = {};
                const required: string[] = [];
                const items = desc.items as Record<string, VtsDesc> | undefined;

                if (items) {
                    for (const [key, field] of Object.entries(items)) {
                        props[key] = VtsJsonSchema.convert(field);
                        if (!field.optional) {
                            required.push(key);
                        }
                    }
                }

                out.properties = props;
                if (required.length > 0) {
                    out.required = required;
                }
                break;
            }

            case 'or':
                if (desc.values) {
                    out.anyOf = desc.values.map(v => VtsJsonSchema.convert(v));
                }
                break;

            case 'unknown':
            default:
                /* No type constraint — accept anything. */
                break;
        }

        return out;
    }

}