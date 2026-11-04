# Identidade anônima de piloto, carreira na nuvem e multiplayer

## Projeto provisionado

- Projeto Supabase: `apex-dynasty-3d` (plano Free, região São Paulo `sa-east-1`).
- Referência: `ztqwdwnauffdsqvgnqpr`.
- Migrations multiplayer/RLS/saves: `20261028211101` (`apex_dynasty_multiplayer`), `20261028211941` (`revoke_anon_public_table_privileges`), `20261029201652` (`google_account_cloud_saves`, tabela `player_saves`) e `20261104120000` (`email_password_auth`: remove o gate Google, adiciona `profiles.username` único, troca as políticas/RPCs para contas de e-mail confirmadas e cria os RPCs de login por nome de usuário).
- O jogo só libera qualquer tela de carreira depois de uma sessão autenticada (identidade anônima criada automaticamente no primeiro acesso, ou conta e-mail antiga pelo link secundário) e do carregamento do save. O banco confere `auth.uid()` em RLS e RPCs; a interface não é a única barreira.

`.env.local` é ignorado pelo Git. O frontend usa somente uma **publishable key**. Nunca coloque `service_role` / `sb_secret_*` em variável `VITE_*`, bundle ou repositório. Não existe mais provedor OAuth nem segredo de provedor neste projeto.

## Status da configuração (verificado em 2026-11-04)

| Item | Estado |
| --- | --- |
| Banco: `profiles`, `rooms`, `room_players`, `race_results`, `player_saves`, `username_attempts` | ✅ aplicados |
| RPCs (`set_username`, `username_available`, `email_for_username`, `load_player_save`, `save_player_save`, sala/corrida) | ✅ 45 funções presentes |
| RLS com gate `is_authenticated_user()` (aceita anônimo **e** e-mail) | ✅ aplicado |
| Site URL / redirect URLs (`https://apex-pro-3d-amber.vercel.app`, `http://localhost:5173`) | ✅ configurados |
| Provedor E-mail | ✅ habilitado, `Confirm email` **desligado** (autoconfirm) — criar conta entra direto |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` na Vercel | ✅ configurados, deploy production READY |
| **Anonymous Sign-Ins** | ❌ **DESLIGADO — único bloqueio que resta** |

`list_migrations` da Management API retorna vazio porque as migrations foram
aplicadas pelo SQL Editor; o schema foi conferido objeto a objeto no banco.

**Para liberar o fluxo sem cadastro:** [Authentication → Sign In / Providers →
Anonymous](https://supabase.com/dashboard/project/ztqwdwnauffdsqvgnqpr/auth/providers)
→ habilite **Enable Anonymous Sign-Ins**. O limite anti-abuso
(`rate_limit_anonymous_users = 30/h`) já está no valor recomendado.

**Sem esse toggle o jogo continua jogável:** `signInAnonymously()` é rejeitado
com HTTP 403 e o gate cai no painel de conta de e-mail
(`state.anonymousUnavailable`), com aviso explicando o motivo. Como o
autoconfirm está ligado, criar conta entra na hora, sem clicar em e-mail.

## Configurar a identidade anônima (passos no painel — faça você mesmo)

1. **Authentication → Sign In / Providers → Anonymous**: habilite **Anonymous Sign-Ins** (valor esperado: ON).
2. **Authentication → Rate Limits**: defina um limite de sign-ins anônimos por IP (sugestão: 30/hora) — esta é a proteção contra criação excessiva de identidades.
3. Mantenha o provedor **E-mail** habilitado apenas para contas antigas (login secundário e futura vinculação de e-mail à identidade anônima).
4. Aplique a migration `20261105200000_anonymous_player_identity.sql` no SQL Editor (ordem: depois das migrations anteriores). Ela é não-destructiva: troca o gate de `require_confirmed_user()` para `require_authenticated_user()` (aceita anônimos), cria `username_attempts` (throttle de 5 nomes/min), adiciona `profiles.username_claimed`/`email_linked` e o trigger dá um username placeholder (`pilot_<hex>`) para anônimos.

## Configurar a autenticação por e-mail e senha (legado)

1. No [Supabase — Authentication Providers](https://supabase.com/dashboard/project/ztqwdwnauffdsqvgnqpr/auth/providers), mantenha o provedor **E-mail** habilitado para contas antigas. **Não habilite Google nem nenhum outro provedor OAuth.**
2. Em Authentication → Settings, mantenha **Confirm email** ligado: o jogador só acessa o jogo depois de clicar no link enviado por e-mail (a tela exibe a opção de reenviar a confirmação).
3. Desligue **Anonymous Sign-Ins** em Authentication → Sign In / Providers; o banco rejeita sessões anônimas mesmo que a opção fique ligada.
4. No [Supabase — URL Configuration](https://supabase.com/dashboard/project/ztqwdwnauffdsqvgnqpr/auth/url-configuration), defina o Site URL real e permita os redirect URLs usados pelo jogo (desenvolvimento local e domínio publicado), incluindo a URL usada no link de recuperação de senha.
5. Aplique as migrations de `supabase/migrations/` (em ordem). A migration `20261104120000_email_password_auth.sql` adiciona a coluna única `username` em `profiles`, atualiza o gatilho `on_auth_user_create_profile` para gravar o `username` enviado no cadastro e reescreve políticas/RPCs com o gate `require_confirmed_user()`.
6. Para desenvolvimento local, configure o ambiente Vite e reinicie o servidor:

   ```dotenv
   VITE_SUPABASE_URL=https://ztqwdwnauffdsqvgnqpr.supabase.co
   VITE_SUPABASE_ANON_KEY=<publishable-key>
   ```

## Fluxo de conta do jogador

- **Cadastro**: nome de usuário único (3–20 caracteres, `[a-zA-Z0-9_]`), e-mail, senha (mín. 8) e confirmação de senha. O cliente chama `auth.signUp` com `username`/`display_name` nos metadados; o gatilho cria a linha em `profiles` e rejeita `username_taken`/`username_invalid`.
- **Confirmação de e-mail**: após o cadastro, a tela pede a confirmação do e-mail e oferece reenvio via `auth.resend({ type: "signup" })`. Sem e-mail confirmado, nenhum acesso às funcionalidades da conta.
- **Login**: por nome de usuário ou e-mail (o RPC `email_for_username` resolve o e-mail) + senha via `auth.signInWithPassword`. A opção **Manter conectado** escolhe entre `localStorage` (persistente) e `sessionStorage` (só até fechar o navegador).
- **Recuperação de senha**: `auth.resetPasswordForEmail` envia o link de redefinição pelo Supabase.
- **Logout**: `auth.signOut` limpa sessão, sala ativa e volta para a tela de login.

## Autorização por conta confirmada e dados

- `profiles`, `rooms`, `room_players`, `race_results` e `player_saves` têm RLS ativo. `anon` não tem privilégios diretos de leitura/escrita; clientes não têm `INSERT`, `UPDATE` ou `DELETE` direto nessas tabelas (o dono do perfil pode atualizar a própria linha).
- As políticas exigem `is_confirmed_user()` — qualquer usuário `authenticated` não anônimo — e rejeitam `is_anonymous=true`. Senhas nunca ficam em tabelas públicas: ficam com hash em `auth.users`, inacessível ao cliente.
- RPCs públicas de multiplayer são wrappers `SECURITY DEFINER` que exigem `require_confirmed_user()` antes de delegar às implementações transacionais internas. As funções internas não são executáveis pelo cliente.
- `username_available`, `email_for_username` e `set_username` apoiam o fluxo de login/cadastro por nome de usuário; `email_for_username` expõe somente o e-mail, nunca credenciais.
- `load_player_save` e `save_player_save` retornam/alteram somente o save associado a `auth.uid()`. A tabela não concede acesso direto; ambos os RPCs exigem conta confirmada, validam o formato/tamanho e usam revisão otimista para rejeitar gravações antigas.
- No primeiro login da conta, o save já existente no dispositivo é enviado somente se a nuvem ainda não tiver um. Se já houver save na nuvem, ele substitui o cache local. Alterações posteriores são sincronizadas automaticamente após pequenas pausas, sem gravar cada frame.
- Leituras seguem o escopo do perfil próprio, salas públicas e membros. Tópicos privados `room:<uuid>` só podem ser acessados por membros da sala; inputs continuam vinculados ao ID do jogador e snapshots só podem vir do host.
- O gatilho de Auth cria o perfil com o `username` do cadastro; o nome de exibição pode ser ajustado pela tela após o login. Nome ou UUID local não são prova de identidade.

## Desenvolvimento, build e deploy

```bash
cp .env.example .env.local
# Preencha a URL e a publishable key.
npm ci
npm run dev
```

As variáveis `VITE_*` são incorporadas ao bundle e devem ser públicas. Para produção, use a URL e a publishable key do projeto e configure Site URL/redirect URLs para o domínio final. Não há deploy verificado nesta entrega.

## Protocolo e limites

- O host continua autoritativo para a_simulação local. O começo é coordenado pela sala; inputs e snapshots dos carros trafegam via Supabase Realtime em intervalos de 50 ms; estado e resultados finais são persistidos por RPC. A timeline/frame-a-frame não é gravada no Postgres.
- É multiplayer com autoridade no navegador, não servidor dedicado: não há rollback, compensação de latência ou anti-cheat da física do host. Perda do host pode encerrar uma corrida ativa.
- Uma conta de e-mail confirmada é obrigatória antes de acessar qualquer parte do jogo, inclusive corridas solo. Sessões anônimas ou e-mails não confirmados não passam pelas políticas nem pelas RPCs.
- Cada save na nuvem é limitado a 8 MiB. Uma falha de sincronização fica visível nas configurações e pode ser tentada novamente; o cache local não é oferecido para exportação.
- O Supabase Free tem cotas, limites e possíveis pausas. Ainda é preciso testar o fluxo completo (cadastro, confirmação, login, logout, recuperação e persistência de sessão) em domínio de produção e corrida com duas contas independentes.
