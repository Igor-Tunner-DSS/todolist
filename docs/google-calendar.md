# Integração com Google Calendar (somente leitura)

O Google Calendar é **apenas uma fonte de leitura**. A sincronização é `Google Calendar → tarefas`.
Nada feito no site (criar, editar, concluir, mudar a data ou excluir tarefas, inclusive as importadas)
chama a API do Google. A Calendar API só é acessada por `calendarGet` (`backend/src/google/client.js`),
que emite exclusivamente `GET`; os únicos `POST` vão aos endpoints OAuth (troca de código, renovação
e revogação de token). Os testes falham se qualquer escrita for feita.

## 1. Pré-requisito: autenticação

O projeto não tinha usuários. Foi adicionada uma autenticação mínima (`backend/src/auth.js`):
cadastro/login por e-mail e senha (scrypt), sessão em cookie `httpOnly` + `SameSite=Lax` (só o hash do token
fica no banco) e cabeçalho `X-Requested-With: todolist` obrigatório em requisições que alteram estado
(proteção CSRF). O ID do usuário vem sempre da sessão, nunca do cliente.

**Mudança de comportamento:** agora é preciso entrar para usar o planner e as tarefas pertencem a um usuário
(`/api/tasks` exige sessão). O **primeiro usuário cadastrado adota as tarefas antigas** (sem dono);
os demais começam vazios. Se quiser cadastro fechado, use `SIGNUP_ENABLED=false` após criar as contas.

## 2. Variáveis de ambiente (`backend/.env`)

Veja `backend/.env.example`. As do Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
`TOKEN_ENCRYPTION_KEY`. Também `FRONTEND_URL`, `CORS_ORIGIN`, `COOKIE_SECURE`, `SIGNUP_ENABLED`.
Sem as quatro do Google, o painel avisa que a integração não está configurada. Nenhum segredo está no repositório.

## 3. Configuração no Google Cloud Console

1. Crie (ou escolha) um projeto em <https://console.cloud.google.com/>.
2. **APIs e serviços → Biblioteca**: ative a **Google Calendar API**.
3. **Google Auth Platform / Tela de consentimento OAuth**: tipo *Externo*; nome do app, e-mail de suporte, domínio
   e links de política de privacidade/termos. Em **Escopos**, adicione somente:
   - `.../auth/calendar.events.readonly`
   - `.../auth/calendar.calendarlist.readonly`
   - (`openid` e `email`, para identificar a conta)
4. Em **Público/Usuários de teste**, adicione os e-mails que usarão o app enquanto ele estiver em modo *Teste*
   (até 100 usuários; nesse modo o Google expira o refresh token em 7 dias, então será preciso reconectar).
5. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web**:
   - *Origens JavaScript autorizadas*: não são necessárias (o fluxo é no servidor).
   - *URIs de redirecionamento autorizadas*: exatamente o valor de `GOOGLE_REDIRECT_URI`
     (dev: `http://localhost:3333/api/integrations/google/callback`; produção: `https://SEU-DOMINIO/api/integrations/google/callback`).
6. Copie *Client ID* e *Client secret* para o `.env`.

### Publicação e verificação (etapas manuais)

Os escopos de Calendar são **sensíveis**. Para liberar o app a usuários fora da lista de teste é preciso mudar o
status para *Em produção* e **enviar o app para verificação do Google** (domínio verificado, política de privacidade,
justificativa dos escopos e, normalmente, um vídeo de demonstração). Até ser aprovado, os usuários veem o aviso
"app não verificado" e há limite de usuários. Isso não pode ser contornado e não está automatizado aqui.
Use HTTPS e `COOKIE_SECURE=true` em produção. A API tem cotas por projeto/usuário; o código usa sincronização
incremental, cache por semana e espera exponencial limitada, mas não altera cotas nem habilita cobrança.

## 4. Como funciona

- **Conectar:** `POST /api/integrations/google/connect` cria `state` aleatório de uso único (10 min, vinculado ao
  usuário) e PKCE (S256) e devolve a URL do Google. O callback valida `state`, usuário da sessão, escopos concedidos
  e o `id_token` (emissor, público, validade); a conta Google é identificada pelo `sub`.
- **Tokens:** criptografados com AES-256-GCM (`TOKEN_ENCRYPTION_KEY`) no banco; nunca vão ao frontend, a logs
  nem a `localStorage`. O access token é renovado sozinho; se o acesso for revogado, a conexão passa a
  `needs_reauth` e o usuário reconecta sem perder tarefas. O log HTTP não registra query strings (o callback leva `code`).
- **Calendários:** lista, seleção persistida por usuário. Só calendários selecionados são consultados.
- **Mapeamento:** `summary → título`; data de início → `due_date` (no fuso do evento); `description` +
  bloco legível ao final (`---` / "Importado do Google Calendar" / Horário / Término / Fuso / Local / Calendário).
  O bloco é regenerado a cada atualização (nunca duplicado). Dia inteiro não ganha horário; faltando título vira
  "(Sem título)". HTML da descrição é removido.
- **Badge:** tarefas importadas (`source = 'google'`) mostram ícone SVG + rótulo "Google Calendar" (com `aria-label`)
  e um acento lateral; tarefas nativas nunca.
- **Sync:** ao abrir o site só roda se a última estiver desatualizada (>15 min). O botão **Sync** força.
  Incremental via `updatedMin` + cancelados (`showDeleted`). Bloqueio por usuário impede execuções simultâneas.
  Erro temporário **nunca** é tratado como exclusão.
- **Intervalo:** padrão hoje −30 / +90 dias, configurável (máx. 2 anos). Ao alterar, o novo período é importado sem
  duplicar; tarefas importadas que ficam fora do intervalo exigem escolha: **manter como cópias locais** (deixam de
  ser sincronizadas) ou **remover** do site.
- **Recorrência sob demanda:** séries (eventos com `recurrence`) **não** são expandidas. Quando o mês exibido muda,
  o frontend pede as semanas (seg–dom) daquela grade (`POST /sync/weeks`); o servidor consulta
  `singleEvents=true` só nessas semanas ∩ intervalo configurado e cria as ocorrências que faltam (chave:
  `calendar_id + event_id` da ocorrência; guarda também `series_id` e `occurrence_start`). Revisitar usa cache de
  10 min por semana/calendário; o botão Sync ignora o cache. Cancelamentos removem a ocorrência (ou a série
  inteira); exceções (título/horário/semana alterados) atualizam a tarefa já materializada.
  Nota: o frontend é uma grade **mensal**, então "semana visualizada" = as semanas que compõem o mês na tela.
- **Edição local:** alterações feitas no site em tarefas importadas ficam só no site e persistem até o evento
  mudar no Google; então título/descrição/data voltam a refletir a origem. A conclusão (`completed`) é sempre local e
  nunca é alterada pelo Google. Se você exclui uma tarefa importada, ela não ressurge.
- **Desmarcar calendário / desconectar:** sempre perguntam *manter cópias locais* ou *remover*. Manter = tarefa
  continua (com badge), sem vínculo/atualização futura. Remover = só tarefas importadas ativas; nativas nunca.
  Ao desconectar, o token é revogado no Google (melhor esforço), apagado do banco e a conexão é removida.

## 5. Banco de dados

`backend/src/migrate.js` (executado ao iniciar o servidor ou com `npm run migrate`) é **incremental e idempotente**,
registra em `schema_migrations` e não apaga nem recria tabelas. Migração `001_users_and_google_calendar`:

| Mudança | Detalhe |
|---|---|
| `tasks.user_id` (NULL, FK) | NULL = tarefa legada; o primeiro cadastro a adota |
| `tasks.source` (`'local'`/`'google'`, padrão `'local'`) | distingue nativas de importadas (não depende de título/data) |
| `tasks.description` → `TEXT` | comporta descrição + bloco de metadados |
| `users`, `sessions` | autenticação |
| `google_connections` | 1 por usuário: conta (`sub`), tokens criptografados, intervalo, estado/último sync, trava |
| `google_calendars` | calendários e seleção, cursor incremental, `has_recurring` |
| `google_event_links` | `user_id, calendar_id, event_id, series_id, occurrence_start, task_id, etag, google_updated, status`; **UNIQUE (user_id, calendar_id, event_id)** impede duplicar |
| `google_oauth_states` | `state` (hash) + verifier PKCE, uso único |
| `google_week_fetches` | cache das semanas já consultadas |

Rodar `schema.sql` continua funcionando (cria a tabela legada); o servidor então migra.

## 6. Testes

Requer MariaDB/MySQL. Os testes **apagam dados**, por isso só rodam em bancos cujo nome termina em `_test`.

```bash
mysql -uroot -e "CREATE DATABASE todolist_test; CREATE USER 'tl'@'%' IDENTIFIED BY 'tl'; GRANT ALL ON todolist_test.* TO 'tl'@'%';"
cd backend && npm install && npm test          # TEST_DB_HOST/PORT/USER/PASSWORD/NAME para outro banco
cd ../frontend && npm install && npm run build
```

Usam o cliente HTTP real contra um Google **falso** (OAuth, paginação, recorrências, 401/429/503, rede fora) e
verificam em todo teste que não houve nenhuma chamada de escrita ao Google. Cobrem os 20 cenários pedidos.
`npm run demo` (backend, porta 3333, Google falso) + `npm run dev` no frontend permite ver a UI sem credenciais.
**Não testado com Google real:** exige credenciais e uma conta (ver seção 3).
