import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileOperationResponse } from '../types';

const PROTO_PATH = path.join(__dirname, '../proto/filesystem.proto');
const CHUNK_SIZE = 1024 * 1024; // 1 MB

export class FileClient {
    private client: any;
    private serverAddress: string;

    constructor(serverAddress: string = 'localhost:50050') {
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
                console.log('Criar arquivo:', response, `Tempo: ${response.time_ms}ms`);
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
                console.log('Ler arquivo:', response, `Tempo: ${response.time_ms}ms`);
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
                console.log('Escrever arquivo:', response, `Tempo: ${response.time_ms}ms`);
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
                console.log('Excluir arquivo:', response, `Tempo: ${response.time_ms}ms`);
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
                console.log(`📁 Listar arquivos`);
                console.log(`⏱️ Tempo de resposta: ${response.time_ms ?? 'desconhecido'}ms`);

                if (response.files?.length > 0) {
                    response.files.forEach((file: any) => {
                        console.log(`- ${file}`);
                    });
                } else {
                    console.log('⚠️ Nenhum arquivo encontrado.');
                }

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

    public async uploadFile(localPath: string, remoteFilename: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            const stream = fs.createReadStream(localPath, { highWaterMark: CHUNK_SIZE });
            const call = this.client.UploadFile((err: any, response: any) => {
                if (err) {
                    reject(err);
                } else {
                    console.log('Upload completo:', response);
                    resolve(response);
                }
            });

            let chunkNumber = 0;
            const fileSize = fs.statSync(localPath).size;
            const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

            stream.on('data', (chunk: Buffer | string) => {
                const chunkChecksum = crypto.createHash('sha256').update(chunk).digest('hex');
                call.write({
                    filename: remoteFilename,
                    chunk: chunk,
                    chunk_number: chunkNumber,
                    total_chunks: totalChunks,
                    checksum: chunkChecksum
                });
                chunkNumber++;
            });

            stream.on('end', () => {
                call.end();
            });

            stream.on('error', (err) => {
                call.cancel();
                reject(err);
            });
        });
    }
}