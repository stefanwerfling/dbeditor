/**
 * Discriminator for the three plugin extension points planned for dbeditor.
 *
 * The string values are the on-the-wire identifiers — they appear in the
 * registry keys and (eventually) in plugin manifest files. Don't rename
 * without also bumping the on-disk format.
 */
export enum PluginKind {
    Dialect = 'dialect',
    FileFormat = 'fileFormat',
    GenerationHook = 'generationHook',
    DbConnection = 'dbConnection'
}