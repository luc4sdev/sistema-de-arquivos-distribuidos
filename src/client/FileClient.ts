import { SocketClient } from './SocketClient';
import { FileOperationResponse } from '../types';
import * as fs from 'fs';
import * as pathFile from 'path';

export class FileClient {
    private socketClient: SocketClient;

    constructor(serverUrl: string = 'http://localhost:3000') {
        this.socketClient = new SocketClient(serverUrl);
    }

    public onConnect(callback: () => void) {
        this.socketClient.onConnect(callback);
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

    public async listFiles(path: string = ''): Promise<FileOperationResponse> {
        return new Promise((resolve) => {
            this.socketClient.listFiles(
                { path },
                (response) => {
                    console.log('Listar arquivos:', response, `Tempo: ${response.timeMs}ms`);
                    if (response.files) {
                        console.log('Arquivos:');
                        response.files.forEach(file => {
                            console.log(`- ${file.name}${file.isDirectory ? '/' : ''}`);
                        });
                    }
                    resolve(response);
                }
            );
        });
    }

    public async copyFile(source: string, destination: string): Promise<FileOperationResponse> {
        return new Promise((resolve) => {
            this.socketClient.copyFile(
                { source, destination },
                (response) => {
                    console.log('Copiar arquivo:', response, `Tempo: ${response.timeMs}ms`);
                    resolve(response);
                }
            );
        });
    }

    public async downloadFile(path: string, outputName?: string): Promise<FileOperationResponse> {
        return new Promise((resolve) => {
            this.socketClient.downloadFile(
                { path, outputName },
                (response) => {
                    console.log('Download arquivo:', response, `Tempo: ${response.timeMs}ms`);
                    if (response.content && response.filename) {
                        const decodedContent = Buffer.from(response.content, 'base64');
                        const outputDir = pathFile.resolve(__dirname, '../../', 'localFiles');
                        if (!fs.existsSync(outputDir)) {
                            fs.mkdirSync(outputDir, { recursive: true });
                        }
                        const localPath = pathFile.join(outputDir, outputName || response.filename);
                        fs.writeFileSync(localPath, decodedContent);

                        console.log(`Arquivo ${response.filename} baixado com sucesso!`);
                    }
                    resolve(response);
                }
            );
        });
    }

    public async runExampleOperations(): Promise<void> {
        this.socketClient.onConnect(async () => {
            await this.createFile('teste.txt', 'Hello World\n');
            await this.listFiles();
            await this.readFile('teste.txt');
            await this.copyFile('teste.txt', 'copia_teste.txt');
            await this.writeFile('teste.txt', 'Mais texto\n');
            await this.readFile('teste.txt');
            await this.downloadFile('teste.txt');
            //await this.deleteFile('teste.txt');
        });
    }

    public disconnect() {
        this.socketClient.disconnect();
    }
}