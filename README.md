# Supremorpg Discord Build Bot

Cloudflare Worker que recebe interações do Discord, cria tickets privados e inicia builds **controlados** dos projetos Android aprovados da organização Supremorpg.

## Fluxo

```text
Discord -> Cloudflare Worker -> workflow no branch main protegido
        -> GitHub Actions artifact -> mensagem no ticket
```

O bot não baixa, extrai nem executa ZIPs, URLs ou wrappers Gradle enviados por usuários. Os únicos targets permitidos são configurados no Worker:

- `supremorpg/medusa-android`
- `supremorpg/aurora-launcher`

Cada projeto mantém seu próprio workflow `android-build.yml`, executado apenas a partir do código versionado no ref configurado.

## Pré-requisitos

- Node 20+
- Conta Cloudflare com um namespace KV para `TICKETS`
- Aplicação Discord com endpoint de Interactions apontando para o Worker
- Token GitHub de escopo mínimo para despachar workflows apenas nos repositórios aprovados
- Segredo compartilhado exclusivo para o callback de build

## Desenvolvimento

```sh
npm ci
cp .dev.vars.example .dev.vars
# Preencha valores locais, sem commitá-los.
npm run validate
npm run dev
```

## Configuração do Worker

1. Crie um KV namespace para o ambiente e substitua `REPLACE_WITH_KV_NAMESPACE_ID` em uma configuração de implantação privada ou de ambiente.
2. Configure as variáveis não secretas em cada ambiente:
   - `DISCORD_GUILD_ID`
   - `DISCORD_TICKET_CATEGORY_ID`
   - `GITHUB_OWNER=supremorpg`
   - `MEDUSA_REPO=medusa-android`
   - `AURORA_REPO=aurora-launcher`
   - `BUILD_WORKFLOW=android-build.yml`
   - `BUILD_REF=main`
3. Defina os secrets com Wrangler ou pelo painel Cloudflare:
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_BOT_TOKEN`
   - `GITHUB_TOKEN`
   - `BUILD_CALLBACK_SECRET`
4. Configure o mesmo `BUILD_CALLBACK_SECRET` como secret nos dois repositórios Android.

`GITHUB_TOKEN` deve ser um fine-grained PAT ou token de GitHub App com apenas a capacidade necessária para `workflow_dispatch` nos dois targets. Não reutilize o token do Discord no callback.

## Operação

1. Faça deploy em staging e valide o PING assinado do Discord.
2. Configure o painel com `/setup-ticket` em uma guilda e categoria autorizadas.
3. Valide criação/fechamento de ticket, um build Medusa, um build Aurora, artefato e callback.
4. Só depois atualize o endpoint de produção no Discord Developer Portal.

Rotacione secrets após migrações e mantenha `main` protegido. Artefatos de APK devem continuar privados/temporários conforme as políticas da organização.
