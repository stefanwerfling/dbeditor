/* eslint-disable max-classes-per-file -- error hierarchy lives in one file */
export class RepoError extends Error {

    public readonly httpStatus: number;
    public constructor(message: string, httpStatus: number) {
        super(message);
        this.httpStatus = httpStatus;
    }

}

export class RepoNotFoundError extends RepoError {

    public constructor(message: string) { super(message, 404); }

}

export class RepoConflictError extends RepoError {

    public constructor(message: string) { super(message, 409); }

}

export class RepoInvalidError extends RepoError {

    public constructor(message: string) { super(message, 400); }

}