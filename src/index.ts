/**
 * Placeholder entry point. Re-export the four platform provider interfaces.
 * This file will be replaced by the MCP server in todo 9.
 */
export type { InputProvider } from './platform/input';
export type { ScreenProvider, CaptureResult } from './platform/screen';
export type { FileProvider, FileContent } from './platform/file';
export type { SafetyProvider, Region, SafetyStatus } from './platform/safety';
