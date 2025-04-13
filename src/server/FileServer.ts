import { promises as fs } from 'fs';
import path from 'path';
import {
    FileOperationResponse,
    CreateFilePayload,
    ReadFilePayload,
    WriteFilePayload,
    DeleteFilePayload,
    ListFilesPayload,
    DownloadFilePayload,
    CopyFilePayload,
} from '../types';

const FILES_DIR = path.join(__dirname, '../../files');

export class FileServer {
    constructor() {
        fs.mkdir(FILES_DIR, { recursive: true }).catch(console.error);
    }

    async listFiles({ path: filePath = '' }: ListFilesPayload): Promise<FileOperationResponse> {
        try {
            const fullPath = this.getSafePath(filePath);
            const files = await fs.readdir(fullPath);

            const filesWithInfo = await Promise.all(
                files.map(async file => {
                    const filePath = path.join(fullPath, file);
                    return {
                        name: file,
                        isDirectory: await this.isDirectory(filePath)
                    };
                })
            );

            return {
                status: 'success',
                files: filesWithInfo
            };
        } catch (err) {
            return { status: 'error', message: (err as Error).message };
        }
    }

    async copyFile({ source, destination }: CopyFilePayload): Promise<FileOperationResponse> {
        try {
            const safeSource = this.getSafePath(source);
            const safeDestination = this.getSafePath(destination);

            await fs.copyFile(safeSource, safeDestination);
            return { status: 'success' };
        } catch (err) {
            return { status: 'error', message: (err as Error).message };
        }
    }

    async downloadFile({ path: filePath, outputName }: DownloadFilePayload): Promise<FileOperationResponse> {
        try {
            const safePath = this.getSafePath(filePath);
            const content = await fs.readFile(safePath);

            return {
                status: 'success',
                filename: outputName || path.basename(safePath),
                content: content.toString('base64')
            };
        } catch (err) {
            return { status: 'error', message: (err as Error).message };
        }
    }


    private getSafePath(userPath: string): string {
        const normalizedPath = path.normalize(userPath);
        const fullPath = path.join(FILES_DIR, normalizedPath);

        if (!fullPath.startsWith(FILES_DIR)) {
            throw new Error('Acesso ao caminho negado');
        }

        return fullPath;
    }

    private async isDirectory(path: string): Promise<boolean> {
        try {
            const stat = await fs.stat(path);
            return stat.isDirectory();
        } catch {
            return false;
        }
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