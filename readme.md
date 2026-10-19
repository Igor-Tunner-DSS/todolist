# TodoList

Aplicação web para organizar tarefas em um calendário mensal. É possível criar tarefas, definir uma data, marcar tarefas como concluídas, editar e excluir itens, além de pesquisar tarefas e alternar entre os temas claro e escuro.

## Requisitos

- [Node.js](https://nodejs.org/) com npm
- MySQL em execução e credenciais de acesso
- Git

## Configuração do ambiente

### 1. Clonar o repositório

```bash
git clone https://github.com/Igor-Tunner-DSS/todolist.git
cd todolist
```

### 2. Instalar as dependências

Execute o comando a partir da raiz do projeto, onde está o `package.json` principal:

```bash
npm install
```

O projeto usa npm workspaces para instalar as dependências do frontend e do backend.

### 3. Configurar as variáveis de ambiente

Na raiz do projeto, crie o arquivo `.env` a partir do modelo `.env.example`.

Linux/macOS:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Abra o arquivo `.env` e preencha os valores conforme o ambiente local:

```dotenv
# Porta em que o backend será executado
PORT=3000

# Conexão com o MySQL
DB_HOST=localhost
DB_PORT=3306
DB_USER=seu_usuario
DB_PASSWORD=sua_senha
DB_NAME=todolist

# Origem permitida pelo CORS (endereço do frontend)
CORS_ORIGIN=http://localhost:5173

# Endereço do backend usado pelo proxy do Vite
VITE_API_BASE_URL=http://localhost:3000
```

Substitua os exemplos pelas configurações reais. Confirme que o MySQL está ativo e que o usuário informado tem permissão para acessar o banco de dados indicado. O banco e a estrutura de tabelas necessários devem existir antes de executar a aplicação.

**Importante:** não compartilhe o arquivo `.env` nem envie credenciais para o controle de versão.

## Executar a aplicação

Abra dois terminais na raiz do projeto.

No primeiro, inicie o backend:

```bash
npm run dev --workspace=backend
```

No segundo, inicie o frontend:

```bash
npm run dev --workspace=frontend
```

O Vite normalmente disponibiliza o frontend em [http://localhost:5173](http://localhost:5173). Se o terminal informar outra URL, use o endereço exibido. O backend usa a porta definida em `PORT`.

## Tecnologias

- **Frontend:** React, TypeScript e Vite
- **Backend:** Node.js e Express/Fastify
- **Banco de dados:** MySQL
