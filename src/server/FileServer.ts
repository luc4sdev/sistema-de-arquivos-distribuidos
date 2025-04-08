import { promises as fs } from 'fs';
import path from 'path';
import {
    FileOperationResponse,
    CreateFilePayload,
    ReadFilePayload,
    WriteFilePayload,
    DeleteFilePayload,
} from '../types';

const FILES_DIR = path.join(__dirname, '../../files');

export class FileServer {
    constructor() {
        fs.mkdir(FILES_DIR, { recursive: true }).catch(console.error);
    }

    async listFiles(): Promise<string[]> {
        return await fs.readdir(FILES_DIR);
    }

    async createFile({ filename, content }: CreateFilePayload): Promise<FileOperationResponse> {
        try {
            await fs.writeFile(path.join(FILES_DIR, filename), content);
            return { status: 'success' };
        } catch (err) {
            return { status: 'error', message: (err as Error).message };
        }
    }

    async readFile({ filename }: ReadFilePayload): Promise<FileOperationResponse> {
        try {
            const content = await fs.readFile(path.join(FILES_DIR, filename), 'utf-8');
            return { status: 'success', content };
        } catch (err) {
            return { status: 'error', message: (err as Error).message };
        }
    }

    async writeFile({ filename, content }: WriteFilePayload): Promise<FileOperationResponse> {
        try {
            await fs.appendFile(path.join(FILES_DIR, filename), content);
            return { status: 'success' };
        } catch (err) {
            return { status: 'error', message: (err as Error).message };
        }
    }

    async deleteFile({ filename }: DeleteFilePayload): Promise<FileOperationResponse> {
        try {
            await fs.unlink(path.join(FILES_DIR, filename));
            return { status: 'success' };
        } catch (err) {
            return { status: 'error', message: (err as Error).message };
        }
    }
}