import { io, Socket } from 'socket.io-client';
import {
    FileOperationResponse,
    CreateFilePayload,
    ReadFilePayload,
    WriteFilePayload,
    DeleteFilePayload,
    ListFilesPayload,
    CopyFilePayload,
    DownloadFilePayload,
} from '../types';

export class SocketClient {
    private socket: Socket;

    constructor(url: string) {
        this.socket = io(url);
        this.setupConnectionHandlers();
    }

    private setupConnectionHandlers() {
        this.socket.on('connect', () => {
            console.log('Conectado ao servidor');
        });

        this.socket.on('disconnect', () => {
            console.log('Desconectado do servidor');
        });
    }

    public createFile(payload: CreateFilePayload, callback: (response: FileOperationResponse) => void) {
        this.socket.emit('create', payload, callback);
    }

    public readFile(payload: ReadFilePayload, callback: (response: FileOperationResponse) => void) {
        this.socket.emit('read', payload, callback);
    }

    public writeFile(payload: WriteFilePayload, callback: (response: FileOperationResponse) => void) {
        this.socket.emit('write', payload, callback);
    }

    public deleteFile(payload: DeleteFilePayload, callback: (response: FileOperationResponse) => void) {
        this.socket.emit('delete', payload, callback);
    }

    public listFiles(payload: ListFilesPayload, callback: (response: FileOperationResponse) => void) {
        this.socket.emit('list', payload, callback);
    }

    public copyFile(payload: CopyFilePayload, callback: (response: FileOperationResponse) => void) {
        this.socket.emit('copy', payload, callback);
    }

    public downloadFile(payload: DownloadFilePayload, callback: (response: FileOperationResponse) => void) {
        this.socket.emit('download', payload, callback);
    }

    public onConnect(callback: () => void) {
        this.socket.on('connect', callback);
    }

    public disconnect() {
        this.socket.disconnect();
    }
}