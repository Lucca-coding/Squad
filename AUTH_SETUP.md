# Configuração da API de contas do SQUAD

Esta etapa adiciona a API de cadastro e login à branch `desenvolvimento`. Ela ainda não conecta a tela de entrada do site ao fluxo de autenticação e não substitui o sistema atual de salas.

## Variáveis obrigatórias no ambiente do servidor

Configure no serviço de hospedagem, nunca diretamente no código:

- `DATABASE_URL`: URL de conexão de um banco PostgreSQL persistente.
- `AUTH_SECRET`: segredo aleatório com pelo menos 32 caracteres, usado para assinar os tokens de sessão.

Não publique esses valores no repositório. Use um banco gerenciado com backups e armazenamento durável; o armazenamento local efêmero do serviço não é suficiente para guardar contas.

## Endpoints adicionados

- `POST /api/auth/register` — cria conta com nome de usuário único e senha.
- `POST /api/auth/login` — autentica com usuário e senha.
- `GET /api/auth/me` — consulta a conta usando `Authorization: Bearer <token>`.
- `PATCH /api/auth/me` — altera nome de exibição, avatar e status de presença.
- `POST /api/auth/logout` — informa que o cliente deve remover o token local.

O nome de usuário aceita 3–24 caracteres (letras, números, ponto, sublinhado e hífen). Senhas têm entre 10 e 128 caracteres e são armazenadas como hash scrypt com salt individual. A API não devolve o hash da senha.

## Teste controlado

Após configurar as duas variáveis em um ambiente de teste:

1. Faça `POST /api/auth/register` com JSON contendo `username`, `password` e opcionalmente `displayName`.
2. Confirme que a resposta contém `user` e `token`, sem dados de senha.
3. Tente cadastrar o mesmo nome novamente; deve retornar HTTP 409.
4. Faça login com a senha correta e incorreta.
5. Use o token em `GET /api/auth/me` e teste um token inválido/expirado.

## Limitações conhecidas desta etapa

- A interface de login/cadastro ainda não está ligada a estes endpoints.
- O login não foi ativado como requisito para as salas existentes; essa migração será feita junto com a interface para evitar bloquear os usuários atuais.
- Salas, canais e mensagens ainda estão em memória. A persistência dessas entidades é uma etapa separada.
- Tokens duram 7 dias. O logout atual é do lado do cliente: remover o token encerra a sessão naquele dispositivo.
- Antes de publicar, é necessário testar em um ambiente separado e configurar o PostgreSQL e `AUTH_SECRET` no serviço de hospedagem.
