import { FileClient } from './FileClient';
import * as readline from 'readline';
import { Notification } from '../types'

export class Cli {
    private fileClient: FileClient;
    private rl: readline.Interface;
    private isSubscribed: boolean;

    constructor() {
        this.fileClient = new FileClient('localhost:50051');
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        this.isSubscribed = false;
    }

    public async start() {
        console.log('Sistemas de Arquivos Distribuídos - Cliente');
        console.log('Comandos disponíveis:');
        console.log('  create <nome> <conteúdo> - Cria um arquivo');
        console.log('  read <nome>              - Lê um arquivo');
        console.log('  write <nome> <conteúdo>  - Atualiza um arquivo');
        console.log('  delete <nome>            - Remove um arquivo');
        console.log('  list [path]              - Lista arquivos');
        console.log('  copy <origem> <destino>  - Copia um arquivo');
        console.log('  download <remoto> [local]- Baixa um arquivo');
        console.log('  subscribe <path1,path2>  - Assina notificações');
        console.log('  unsubscribe              - Cancela assinaturas');
        console.log('  exit                     - Sai do programa');

        this.fileClient.onConnect(() => {
            this.showPrompt();
        });

        this.rl.on('close', () => {
            console.log('Desconectando...');
            this.fileClient.disconnect();
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
                    case 'copy':
                        await this.handleCopy(args);
                        break;
                    case 'download':
                        await this.handleDownload(args);
                        break;
                    case 'subscribe':
                        await this.handleSubscribe(args);
                        break;
                    case 'unsubscribe':
                        await this.handleUnsubscribe();
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

    private async handleCopy(args: string[]) {
        if (args.length < 2) {
            console.log('Uso: copy <origem> <destino>');
            return;
        }
        await this.fileClient.copyFile(args[0], args[1]);
    }

    private async handleDownload(args: string[]) {
        if (args.length < 1) {
            console.log('Uso: download <arquivo_remoto> [arquivo_local]');
            return;
        }
        const outputPath = args.length > 1 ? args[1] : undefined;
        await this.fileClient.downloadFile(args[0], outputPath);
    }

    private async handleSubscribe(args: string[]) {
        if (args.length < 1) {
            console.log('Uso: subscribe <caminho1,caminho2>');
            return;
        }

        const paths = args[0].split(',');

        await this.fileClient.subscribe(paths, (notification) => {
            console.log('\n=== NOTIFICAÇÃO ===');
            console.log('Tipo:', notification.event_type);
            console.log('Arquivo:', notification.file_path);
            console.log('===================');
            this.showPrompt();
        });

        this.isSubscribed = true;
        console.log(`Inscrito para notificações em: ${paths.join(', ')}`);
    }

    private async handleUnsubscribe() {
        await this.fileClient.unsubscribe();
        this.isSubscribed = false;
        console.log('Assinaturas canceladas. Não receberá mais notificações.');
    }
}