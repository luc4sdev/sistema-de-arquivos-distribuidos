import { FileClient } from './FileClient';
import * as readline from 'readline';

export class Cli {
    private fileClient: FileClient;
    private rl: readline.Interface;

    constructor() {
        this.fileClient = new FileClient();
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    public async start() {
        console.log('Sistemas de Arquivos Distribuídos - Cliente');
        console.log('Comandos disponíveis: create, read, write, delete, exit');

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
}