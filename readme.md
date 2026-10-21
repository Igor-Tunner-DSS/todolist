# ESPECIFICAÇÕES DA ATIVIDADE

* Ver a lista de tarefas pendentes e concluídas;
* Criar uma nova tarefa, com nome e uma data limite opcional;
* Editar uma tarefa já existente (nome e data);
* Marcar uma tarefa como concluída ou reabri-la;
* Excluir tarefas;
* Buscar tarefas pelo nome, em tempo real;
* Ver, visualmente, quais tarefas estão "em atraso" (data limite vencida e ainda pendente).


## Integração com Google Calendar

Importação somente leitura de eventos do Google Calendar como tarefas (nunca escreve no calendário).
Configuração, segurança, banco de dados e testes: [docs/google-calendar.md](docs/google-calendar.md).
Backend: `cd backend && cp .env.example .env && npm install && npm start` · Frontend: `cd frontend && npm install && npm run dev`.
