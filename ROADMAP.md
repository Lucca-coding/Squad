# SQUAD — Plano de desenvolvimento

Esta branch é destinada ao desenvolvimento e teste. A branch `main` e o serviço publicado devem permanecer intactos até aprovação explícita para publicar.

## Regras de segurança
- Não fazer deploy de `desenvolvimento` para produção.
- Nunca guardar senhas em texto puro; usar hash de senha com salt e comparação segura.
- Validar permissões no servidor, não apenas esconder botões na interface.
- Persistir contas, salas, canais e mensagens em armazenamento durável antes de prometer histórico permanente.
- Não apagar mensagens automaticamente. Limpeza completa de canal só por administrador autorizado e após confirmação.
- Testar reconexão, usuários simultâneos, permissões e chamadas antes de mesclar.

## Etapas propostas
1. **Fundação e contas:** banco persistente, cadastro/login com nome de usuário único e senha, nome público/avatar editáveis e sessão autenticada.
2. **Salas:** nome, descrição e mini banner; permissões para dono/admin; persistência das configurações.
3. **Canais e mensagens:** canais de texto e voz, criação/exclusão conforme permissões, data/hora, anexos, histórico persistente, exclusão manual permitida conforme regra e limpeza de canal por admin com confirmação.
4. **Cargos e presença:** cargos e permissões, status Online/Ausente/Não perturbar/Invisível e indicação de offline.
5. **Áudio e chamadas:** seleção de dispositivos de entrada/saída, cancelamento de eco, supressão de ruído, teste de microfone com aviso para usar fones, sons de entrada e mute com opção de desativá-los.
6. **Validação:** testes de segurança e regressão; revisão em ambiente separado antes de abrir PR para `main`.

## Estado inicial verificado
- Servidor Socket.IO mantém salas e mensagens em memória; elas se perdem ao reiniciar.
- A identidade atual é derivada de uma chave de cliente, não de uma conta com login.
- Já existem canais de texto básicos, cargos básicos, presença online/offline por conexão e chamadas de voz.
- O pacote do servidor precisa ser verificado separadamente do pacote raiz antes de modificar dependências ou deploy.

## Bloqueio para persistência em produção
A implementação de contas e histórico permanente precisa de um banco durável configurado no ambiente do servidor. Não considerar armazenamento em memória ou disco efêmero como persistência de produção.
