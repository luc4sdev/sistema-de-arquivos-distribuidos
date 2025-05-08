import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'fs';
import * as path from 'path';
import { FileOperationResponse } from '../types';

const PROTO_PATH = path.join(__dirname, '../proto/filesystem.proto');

export class FileClient {
    private client: any;
    private serverAddress: string;

    constructor(serverAddress: string = 'localhost:50051') {
        this.serverAddress = serverAddress;
        this.initializeClient();
    }

    private initializeClient() {
        const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true
        });

        const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
        this.client = new protoDescriptor.filesystem.FileSystem(
            this.serverAddress,
            grpc.credentials.createInsecure()
        );
    }

    public onConnect(callback: () => void) {
        process.nextTick(callback);
    }

    public async createFile(filename: string, content: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.CreateFile({ filename, content }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Criar arquivo:', response, `Tempo: ${response.timeMs}ms`);
                resolve(response);
            });
        });
    }

    public async readFile(filename: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.ReadFile({ filename }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Ler arquivo:', response, `Tempo: ${response.timeMs}ms`);
                resolve(response);
            });
        });
    }

    public async writeFile(filename: string, content: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.WriteFile({ filename, content }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Escrever arquivo:', response, `Tempo: ${response.timeMs}ms`);
                resolve(response);
            });
        });
    }

    public async deleteFile(filename: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.DeleteFile({ filename }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Excluir arquivo:', response, `Tempo: ${response.timeMs}ms`);
                resolve(response);
            });
        });
    }

    public async listFiles(path: string = ''): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.ListFiles({ path }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Listar arquivos:', response, `Tempo: ${response.timeMs}ms`);
                if (response.files) {
                    console.log('Arquivos:');
                    response.files.forEach((file: any) => {
                        console.log(`- ${file.name}${file.isDirectory ? '/' : ''}`);
                    });
                }
                resolve(response);
            });
        });
    }

    public async copyFile(source: string, destination: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.CopyFile({ source, destination }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Copiar arquivo:', response, `Tempo: ${response.timeMs}ms`);
                resolve(response);
            });
        });
    }

    public async downloadFile(remotePath: string, outputName?: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.DownloadFile({
                path: remotePath,
                output_name: outputName
            }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Download arquivo:', response, `Tempo: ${response.timeMs}ms`);
                if (response.content && response.filename) {
                    const decodedContent = Buffer.from(response.content, 'base64');
                    const outputDir = path.resolve(__dirname, '../../', 'localFiles');
                    if (!fs.existsSync(outputDir)) {
                        fs.mkdirSync(outputDir, { recursive: true });
                    }
                    const localPath = path.join(outputDir, outputName || response.filename);
                    fs.writeFileSync(localPath, decodedContent);
                    console.log(`Arquivo ${response.filename} baixado com sucesso!`);
                }
                resolve(response);
            });
        });
    }

    public async runExampleOperations(): Promise<void> {
        await this.createFile('teste.txt', 'Hello World\n');
        await this.listFiles();
        await this.readFile('teste.txt');
        await this.copyFile('teste.txt', 'copia_teste.txt');
        await this.writeFile('teste.txt', 'Mais texto\n');
        await this.readFile('teste.txt');
        await this.downloadFile('teste.txt');
    }

    public disconnect() {
        // gRPC não precisa de desconexão explícita
        // O canal será fechado automaticamente quando não estiver mais em uso
    }
}