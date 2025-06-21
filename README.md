## 💻 Sistema de Arquivos Distribuídos

O projeto consiste em um Sistema de Arquivos Distribuídos utilizando WebSockets, foi desenvolvido o servidor e o cliente o qual pode ser acessado através de uma CLI.
O projeto foi desenvolvido em NodeJS e Typescript, juntamente com a biblioteca Socket.io.
É possível (Criar, Buscar, Atualizar, Ler, Copiar, Baixar e Deletar) arquivos.
Também foi implementada métricas para cada método e ao final da conexão do cliente é criado um gráfico representando cada operação e seu tempo em ms

<br/>

## 💻 Pré-requisitos

Antes de começar, verifique se você atendeu aos seguintes requisitos:
* Você tem uma máquina `<Windows / Linux / Mac>`
* Você instalou a versão mais recente do `NodeJS`

<br/>

## ⚙️ Instalando

Para instalar execute no terminal:

npm:
```
npm i
```

yarn:
```
yarn install
```

pnpm:
```
pnpm i
```

<br/>
<br/>

## 🚀 Rodando o projeto

Para rodar o projeto digite no terminal:

npm:
```
docker compose up -d
npm run dev
# Terminal 1 (Nó Primário - Porta 50051)
$env:NODE_ID="node1"; $env:PORT="50051"; $env:STORAGE_PATH="./nodes"; npm run dev:server

# Terminal 2 (Réplica 1 - Porta 50052)
$env:NODE_ID="node2"; $env:PORT="50052"; $env:STORAGE_PATH="./nodes"; npm run dev:server

# Terminal 3 (Réplica 2 - Porta 50053)
$env:NODE_ID="node3"; $env:PORT="50053"; $env:STORAGE_PATH="./nodes"; npm run dev:server
```
yarn:
```
yarn dev
yarn dev:server
```

pnpm:
```
pnpm run dev
pnpm run dev:server
```

<br/>


## 🚀 Tecnologias utilizadas

O projeto está desenvolvido utilizando as seguintes tecnologias:

- Typescript <img width="25px" height="25px" src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/typescript/typescript-original.svg" />
- NodeJS <img width="25px" height="25px" src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/nodejs/nodejs-original.svg" />
- Socket.io <img width="25px" height="25px" src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/socketio/socketio-original.svg" />


