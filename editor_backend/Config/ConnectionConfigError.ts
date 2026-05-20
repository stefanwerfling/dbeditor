export type ConnectionConfigErrorCode =
    | 'invalid-config'
    | 'invalid-input'
    | 'unknown-project'
    | 'duplicate-connection'
    | 'unknown-connection';

export class ConnectionConfigError extends Error {

    public readonly code: ConnectionConfigErrorCode;
    public readonly details: string[];

    public constructor(code: ConnectionConfigErrorCode, message: string, details: string[] = []) {
        super(message);
        this.name = 'ConnectionConfigError';
        this.code = code;
        this.details = details;
    }

}