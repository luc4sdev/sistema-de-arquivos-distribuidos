import { SocketClient } from './SocketClient';
import { FileOperationResponse } from '../types';

export class FileClient {
    private socketClient: SocketClient;

    constructor(serverUrl: string = 'http://localhost:3000') {
        this.socketClient = new SocketClient(serverUrl);
    }

    public async createFile(filename: string, content: string): Promise<FileOperationResponse> {
        return new Promise((resolve) => {
            this.socketClient.createFile(
                { filename, content },
                (response) => {
                    console.log('Criar arquivo:', response, `Tempo: ${response.timeMs}ms`);
                    resolve(response);
                }
            );
        });
    }

    public async readFile(filename: string): Promise<FileOperationResponse> {
        return new Promise((resolve) => {
            this.socketClient.readFile(
                { filename },
                (response) => {
                    console.log('Ler arquivo:', response, `Tempo: ${response.timeMs}ms`);
                    resolve(response);
                }
            );
        });
    }

    public async writeFile(filename: string, content: string): Promise<FileOperationResponse> {
        return new Promise((resolve) => {
            this.socketClient.writeFile(
                { filename, content },
                (response) => {
                    console.log('Escrever arquivo:', response, `Tempo: ${response.timeMs}ms`);
                    resolve(response);
                }
            );
        });
    }

    public async deleteFile(filename: string): Promise<FileOperationResponse> {
        return new Promise((resolve) => {
            this.socketClient.deleteFile(
                { filename },
                (response) => {
                    console.log('Excluir arquivo:', response, `Tempo: ${response.timeMs}ms`);
                    resolve(response);
                }
            );
        });
    }

    public async runExampleOperations(): Promise<void> {
        this.socketClient.onConnect(async () => {
            await this.createFile('teste.txt', 'Hello World\n');
            await this.readFile('teste.txt');
            await this.writeFile('teste.txt', 'Mais texto\n');
            await this.readFile('teste.txt');
            //await this.deleteFile('teste.txt');
        });
    }

    public disconnect() {
        this.socketClient.disconnect();
    }
}