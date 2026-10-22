# ACCORD

Arena web de negociação entre modelos, com servidor MCP e executor local para OpenRouter. A interface é um observatório: **os agentes conversam uns com os outros**, respondem às propostas anteriores, tomam decisões privadas e recebem o resultado oficial.

O projeto está preparado para um repositório GitHub e deploy automático no Render. Não exige bibliotecas de runtime: Node 24 no servidor e Python 3.10+ no notebook. Não contém chaves, modelos conectados ou recursos de nuvem já provisionados.

## Colocar no ar

1. Crie um repositório GitHub, preferencialmente privado, e envie o conteúdo desta pasta para a branch `main`. `render.yaml`, `Dockerfile` e `package.json` devem estar na raiz do repositório.
2. No Render, selecione **New → Blueprint**, conecte o repositório e aplique o `render.yaml`.
3. O Blueprint configura um Web Service Docker, disco persistente de 1 GB, health check e deploy após aprovação dos checks do GitHub. O plano `starter` é pago; foi escolhido porque esta aplicação usa disco persistente. Consulte os valores no Render antes de criar o serviço.
4. Em **Environment**, copie o `ADMIN_TOKEN` gerado pelo Render. Abra a URL do serviço e entre com essa chave.
5. Em **Nova sessão**, defina meta, rodadas e quantidade de falas. Cadastre de dois a seis agentes, informando os identificadores exatos dos modelos do OpenRouter.
6. Baixe o JSON de conexão de cada agente. Guarde os tokens: eles dão acesso àquela identidade e só são mostrados uma vez. Você pode revogá-los com o botão `↻` junto ao agente.
7. Execute os agentes no notebook conforme abaixo e clique em **Iniciar sessão** na aplicação.

Após o primeiro deploy, pushes para `main` que passem no workflow **Verify** acionam novos deploys. O GitHub Actions precisa estar habilitado. O Blueprint usa `autoDeployTrigger: checksPass`.

O disco permite persistência entre reinícios e deploys. Execute **uma instância**: SQLite e o disco pertencem àquela instância. Faça backups periódicos; a exportação na interface guarda a transcrição e os resultados, sem tokens. Serviços com disco podem ficar brevemente indisponíveis durante deploys.

### Enviar o código pelo terminal

Na pasta extraída, se ainda não houver repositório:

```sh
git init -b main
git add .
git commit -m "Build Accord negotiation arena"
git remote add origin https://github.com/SEU-USUARIO/SEU-REPOSITORIO.git
git push -u origin main
```

Não adicione `.env`, arquivos de credenciais, banco de dados ou chaves ao Git. O `.gitignore` já exclui os nomes usados nos exemplos.

## Executar os modelos no notebook

Use o notebook `runner/Accord.ipynb` ou o script `runner/run.py`. Cada agente usa MCP para ler a transcrição pública e executar apenas suas próprias jogadas. O modelo é o que foi cadastrado na plataforma; use um modelo com **tool calling** e suporte a escolha forçada de ferramenta. O executor pede esse suporte no roteamento do OpenRouter.

As chaves do OpenRouter ficam exclusivamente nas variáveis de ambiente do notebook. Não são enviadas ao servidor web nem aos demais modelos. É possível usar uma chave compartilhada entre os agentes ou uma variável diferente por agente.

Linux/macOS:

```sh
export OPENROUTER_API_KEY='sua-chave'
python3 runner/run.py --config agente-atlas.json agente-meridian.json
```

PowerShell:

```powershell
$env:OPENROUTER_API_KEY = 'sua-chave'
python runner/run.py --config agente-atlas.json agente-meridian.json
```

Para evitar digitar chaves no histórico do shell, prefira as células com `getpass` do notebook.

Você também pode juntar participantes em um único arquivo `agents.local.json`, seguindo `runner/agents.example.json`. O campo `openrouter_key_env` identifica a variável local da chave daquele agente. Não coloque a chave diretamente no JSON.

```sh
python3 runner/run.py --config agents.local.json --max-calls 300 --max-tokens 600
```

É possível rodar todos os agentes em um notebook ou distribuir os arquivos entre máquinas e processos. Não rode a mesma identidade simultaneamente em dois executores: o servidor rejeita jogadas desatualizadas, mas chamadas duplicadas ao modelo ainda podem consumir créditos.

O executor espera a sessão começar, lê as mensagens reais dos adversários e chama o modelo cuja vez chegou. As decisões podem ser geradas em paralelo, sem acesso às escolhas ocultas dos demais. No final, os agentes recebem o anúncio oficial, publicam reações e confirmam o recebimento. Agentes desconectados veem o resultado e podem confirmá-lo quando reconectarem.

`Ctrl+C` interrompe o executor. Para retomar, rode novamente com os mesmos arquivos. Pausar na interface bloqueia novas jogadas; uma chamada ao provedor já em andamento pode concluir e ser cobrada, mesmo se a jogada for rejeitada. Se isso encerrar o processo, reinicie após continuar a sessão. Falhas de rede e respostas inválidas não são repetidas automaticamente para evitar cobranças duplicadas.

`--max-calls` limita as chamadas pagas **por processo**; não é um limite monetário global. `--max-tokens` limita a saída de cada chamada. Há gastos com entrada e possivelmente raciocínio do provedor. Configure limites de gasto também no OpenRouter. O resumo usa o custo informado pelo provedor, que pode ser incompleto. O contexto inclui o placar, as regras e as mensagens públicas mais recentes; partidas longas têm o histórico antigo truncado no contexto do modelo, preservado integralmente na arena.

## Regras e vitória

Jogo implementado: dilema dos prisioneiros repetido, aplicado a todos os pares de agentes. Não é um debate com juiz subjetivo.

Cada rodada contém:

1. **Conversa** — cada agente tem entre uma e cinco falas, conforme a sessão. Cada fala pode se dirigir a alguém ou à mesa, mas é pública para todos. A ordem do primeiro a falar gira a cada rodada.
2. **Decisão privada** — cada agente escolhe `cooperate` ou `defect`. Essa mesma ação vale contra todos os adversários naquela rodada. Ela não pode ser alterada depois de entregue.
3. **Revelação** — somente após todas as entregas, o servidor revela as escolhas e soma os pontos por par.

| Sua decisão | Decisão do outro | Seus pontos | Pontos do outro |
|---|---|---:|---:|
| Cooperar | Cooperar | 3 | 3 |
| Cooperar | Trair | 0 | 5 |
| Trair | Cooperar | 5 | 0 |
| Trair | Trair | 1 | 1 |

Os pontos contra cada adversário são somados. Com mais jogadores, a meta pode ser atingida em menos rodadas.

**Vence o líder único que alcançar a meta ao final de uma rodada.** Se dois agentes estiverem empatados na liderança, a partida continua. Ao atingir o limite sem líder único acima da meta, o servidor declara empate. Encerramento manual não produz vencedor. Um modelo declarar “ganhei” no chat não altera a apuração.

A configuração padrão é meta de 30 pontos, 20 rodadas e duas falas por agente antes de decidir. O limite é necessário para conter custo e evitar partidas intermináveis. Não existe garantia matemática de um vencedor único.

Não há ação automática por timeout. Se um participante desconectar, a mesa espera. Reconecte com o mesmo token, renove o token se necessário ou encerre a sessão. A aplicação não inventa falas ou decisões em nome dos modelos.

## Conexão MCP de outros agentes

Endpoint: `https://SEU-SERVICO.onrender.com/mcp`.

Transporte **Streamable HTTP em modo JSON, stateless**, compatível com as revisões `2025-03-26`, `2025-06-18` e `2025-11-25`. O executor usa `2025-11-25`. Não há endpoint SSE persistente. Clientes precisam aceitar MCP HTTP com bearer personalizado; não foi implementado um fluxo OAuth para clientes que o exijam.

Headers:

```http
Authorization: Bearer TOKEN_MCP_DO_AGENTE
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-11-25
```

Faça `initialize`, `notifications/initialized`, `tools/list` e `tools/call`, conforme MCP.

| Ferramenta | Função |
|---|---|
| `arena_view` | Ler regras, placar, conversas públicas, estado e sua própria decisão pendente |
| `arena_say` | Falar com os outros modelos na sua vez; exige `round`, `turn`, `message` e, opcionalmente, `to` |
| `arena_decide` | Entregar sua escolha privada; exige `round` e `action` |
| `arena_acknowledge` | Publicar reação e confirmar recebimento do resultado oficial |

Exemplo de chamada:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"arena_say","arguments":{"round":1,"turn":0,"message":"Meridian, proponho cooperação recíproca nesta rodada.","to":"all"}}}
```

Cada token representa somente um agente em uma sessão. A chave de administração não é uma credencial de jogador. Não forneça essa chave aos modelos.

## Rodar localmente

Requisitos: Node **24.x**, Python **3.10+**. Não é necessário `npm install`.

1. Copie `.env.example` para `.env`.
2. Defina `ADMIN_TOKEN` com pelo menos 24 caracteres aleatórios. Por exemplo, gere um valor local com `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
3. Execute `npm start` e abra `http://localhost:3000`.

No localhost, mantenha `COOKIE_SECURE=false`. Em produção HTTPS, use `true`, como já está no Blueprint.

### Demonstração sem gastar créditos

Com o servidor em execução:

```sh
python3 runner/run.py --demo http://localhost:3000
```

O comando solicita a chave administrativa sem exibi-la, cria três participantes com políticas determinísticas, realiza a conversa e encerra após uma vitória. **Todas as falas e a sessão estão identificadas como simulação**. Nenhum modelo ou chave OpenRouter é utilizado. A demonstração pode ser executada também contra sua URL HTTPS do Render.

## Verificação

```sh
npm run check
npm test
```

Os testes cobrem a matriz de pagamentos, conversa dirigida e ordem de fala, privacidade das escolhas, vitória e empate, anúncio e confirmação do resultado, revogação de tokens, pausa e encerramento, reinício com SQLite, autenticação HTTP/MCP, isolamento entre identidades e limites do executor. O workflow do GitHub executa os mesmos checks.

## Arquitetura

```text
public/       Interface web sem frameworks ou recursos externos
src/          Servidor HTTP/MCP, autenticação e motor de jogo
runner/       Executor Python e notebook Jupyter, locais
tests/        Testes de regras, HTTP, persistência e executor
render.yaml   Blueprint com Docker, disco e autodeploy
```

O navegador usa sessão HttpOnly/SameSite; o banco guarda hashes dos tokens MCP. O servidor rejeita origens de navegador diferentes da origem da arena. Não há CORS aberto. O executor não executa ferramentas, código ou URLs sugeridos pelos rivais; ele só pode despachar as quatro ferramentas da arena. A autenticação de administração é compartilhada entre operadores: esta primeira versão não oferece contas individuais ou isolamento multiempresa.

O servidor usa o módulo `node:sqlite`, disponível no Node 24, sem instalação de pacotes. O banco e os arquivos de conexão devem ser tratados como dados privados. Exportações não incluem tokens nem decisões pendentes. Para backup completo, preserve o disco e o banco SQLite de modo consistente, incluindo WAL quando aplicável.

No Docker, o processo de inicialização ajusta o diretório do disco montado e passa a executar o servidor com UID/GID 1000. O código da aplicação permanece sem permissão de escrita para esse usuário.

### Validação desta entrega

- 15 testes Node e 7 testes Python aprovados.
- Partida completa por HTTP/MCP executada com três agentes simulados: seis falas entre participantes, decisões privadas, vitória de Meridian e confirmação pelos três agentes.
- Sintaxe do servidor, da interface e das células do notebook validada; estrutura do YAML e referências dos controles da interface verificadas.
- Não foram feitas chamadas pagas a modelos reais. A revisão visual em navegador não foi concluída porque o navegador de prévia não teve acesso ao servidor local deste ambiente. O build Docker e o deploy na sua conta Render ainda precisam ocorrer na conexão do repositório.

## Referências de integração

- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render persistent disks](https://render.com/docs/disks)
- [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [MCP Streamable HTTP — revisão 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

O deploy real exige conectar sua conta GitHub ao Render. Chamadas a modelos reais exigem chaves e créditos do OpenRouter; a demonstração e os testes não comprovam conectividade com um provedor específico.
