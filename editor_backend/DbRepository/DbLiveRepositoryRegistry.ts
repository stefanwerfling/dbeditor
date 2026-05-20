import {DbLiveRepository} from './DbLiveRepository.js';

/**
 * Maps a runtime project unid (same key as the model registry) to its live
 * repository. Created once at server start; lifetime matches the dev-server
 * process.
 */
export class DbLiveRepositoryRegistry {

    private _byUnid = new Map<string, DbLiveRepository>();

    public register(unid: string, repo: DbLiveRepository): void {
        this._byUnid.set(unid, repo);
    }

    public get(unid: string): DbLiveRepository | undefined {
        return this._byUnid.get(unid);
    }

    public entries(): IterableIterator<[string, DbLiveRepository]> {
        return this._byUnid.entries();
    }

}