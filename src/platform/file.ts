/**
 * FileProvider abstracts platform-specific filesystem access.
 *
 * NOTE: pure type declaration only — no platform code here.
 */

/** A file's text content plus the encoding it was decoded with. */
export interface FileContent {
  content: string;
  encoding: string;
}

export interface FileProvider {
  /** Read a text file from an absolute path. */
  readFile(path: string): Promise<FileContent>;
  /** List the immediate entries of a directory. */
  listDirectory(path: string): Promise<string[]>;
}
