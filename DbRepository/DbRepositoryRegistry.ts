import {DbFsRepository} from './DbFsRepository.js';

/**
 * Maps a runtime project unid to its repository. The unid is generated when
 * we load the config; restarting the server gives every project a new unid,
 * so the frontend must re-fetch /api/load-schema after a reload.
 */
export class DbRepositoryRegistry {

    private _byUnid = new Map<string, DbFsRepository>();

    public register(unid: string, repo: DbFsRepository): void {
        this._byUnid.set(unid, repo);
    }

    public get(unid: string): DbFsRepository | undefined {
        return this._byUnid.get(unid);
    }

    public entries(): IterableIterator<[string, DbFsRepository]> {
        return this._byUnid.entries();
    }

    public async flushAll(): Promise<void> {
        await Promise.all([...this._byUnid.values()].map(r => r.flush()));
    }

}