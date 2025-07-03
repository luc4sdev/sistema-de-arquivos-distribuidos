import { FileClient } from './FileClient';
import * as readline from 'readline';
import * as fs from 'fs';
import path from 'path';

export class Cli {
    private fileClient: FileClient;
    private rl: readline.Interface;

    constructor() {
        this.fileClient = new FileClient('localhost:50050');
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    public async start() {
        console.log('Sistemas de Arquivos Distribuídos - Cliente');
        console.log('Comandos disponíveis:');
        console.log('  create <nome> <conteúdo> - Cria um arquivo');
        console.log('  read <nome>              - Lê um arquivo');
        console.log('  write <nome> <conteúdo>  - Atualiza um arquivo');
        console.log('  delete <nome>            - Remove um arquivo');
        console.log('  list [path]              - Lista arquivos');
        console.log('  download <remoto> [local]- Baixa um arquivo');
        console.log('  upload <local> <remoto> - Envia um arquivo grande em chunks');
        console.log('  exit                     - Sai do programa');

        this.fileClient.onConnect(() => {
            this.showPrompt();
        });

        this.rl.on('close', () => {
            console.log('Desconectando...');
            process.exit(0);
        });
    }

    private showPrompt() {
        this.rl.question('> ', async (input) => {
            const [command, ...args] = input.trim().split(' ');

            try {
                switch (command.toLowerCase()) {
                    case 'create':
                        await this.handleCreate(args);
                        break;
                    case 'read':
                        await this.handleRead(args);
                        break;
                    case 'write':
                        await this.handleWrite(args);
                        break;
                    case 'delete':
                        await this.handleDelete(args);
                        break;
                    case 'list':
                        await this.handleList(args);
                        break;
                    case 'download':
                        await this.handleDownload(args);
                        break;
                    case 'upload':
                        await this.handleUpload(args);
                        break;
                    case 'exit':
                        this.rl.close();
                        return;
                    default:
                        console.log('Comando inválido. Use: create, read, write, delete ou exit');
                }
            } catch (error) {
                console.error('Erro:', error instanceof Error ? error.message : error);
            }

            this.showPrompt();
        });
    }

    private async handleCreate(args: string[]) {
        if (args.length < 2) {
            console.log('Uso: create <nome_arquivo> <conteúdo>');
            return;
        }
        const filename = args[0];
        const content = args.slice(1).join(' ');
        await this.fileClient.createFile(filename, content);
    }

    private async handleRead(args: string[]) {
        if (args.length < 1) {
            console.log('Uso: read <nome_arquivo>');
            return;
        }
        await this.fileClient.readFile(args[0]);
    }

    private async handleWrite(args: string[]) {
        if (args.length < 2) {
            console.log('Uso: write <nome_arquivo> <novo_conteúdo>');
            return;
        }
        const filename = args[0];
        const content = args.slice(1).join(' ');
        await this.fileClient.writeFile(filename, content);
    }

    private async handleDelete(args: string[]) {
        if (args.length < 1) {
            console.log('Uso: delete <nome_arquivo>');
            return;
        }
        await this.fileClient.deleteFile(args[0]);
    }

    private async handleList(args: string[]) {
        const path = args.length > 0 ? args[0] : '';
        await this.fileClient.listFiles(path);
    }

    private async handleDownload(args: string[]) {
        if (args.length < 1) {
            console.log('Uso: download <arquivo_remoto> [arquivo_local]');
            return;
        }
        const outputPath = args.length > 1 ? args[1] : undefined;
        await this.fileClient.downloadFile(args[0], outputPath);
    }

    private async handleUpload(args: string[]) {
        if (args.length < 2) {
            console.log('Uso: upload <caminho_local> <nome_remoto>');
            return;
        }
        const localPath = path.resolve(__dirname, '../../localFiles', args[0]);
        const remoteFilename = args[1];

        try {
            if (!fs.existsSync(localPath)) {
                console.log(`Arquivo local não encontrado: ${localPath}`);
                return;
            }

            console.log(`Iniciando upload de ${localPath} como ${remoteFilename}...`);
            await this.fileClient.uploadFile(localPath, remoteFilename);
            console.log('Upload concluído com sucesso!');
        } catch (error) {
            console.error('Erro durante upload:', error instanceof Error ? error.message : error);
        }
    }
}