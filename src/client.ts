import { Cli } from './client/Cli';

async function main() {
    const cli = new Cli();

    try {
        await cli.start();
    } catch (error) {
        console.error('Erro no cliente:', error);
    }
}

main();