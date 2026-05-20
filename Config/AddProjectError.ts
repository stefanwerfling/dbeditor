export type AddProjectErrorCode =
    | 'invalid-config'
    | 'invalid-input'
    | 'duplicate-name'
    | 'duplicate-schema-path'
    | 'unknown-project';

export class AddProjectError extends Error {

    public readonly code: AddProjectErrorCode;
    public readonly details: string[];

    public constructor(code: AddProjectErrorCode, message: string, details: string[] = []) {
        super(message);
        this.name = 'AddProjectError';
        this.code = code;
        this.details = details;
    }

}