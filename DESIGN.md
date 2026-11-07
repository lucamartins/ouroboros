# Ouroboros — design

> Plugin do Claude Code que aprende sozinho com as suas sessões: grava memórias e cria/refina skills sem você pedir, no espírito do Hermes Agent (Nous Research), e mostra num dashboard local o que aprendeu, o quanto isso está sendo usado e quanto custa.

Status: **desenho** (nenhum código ainda). Decisões do dono em [§12](#12-decisões-tomadas).

---

## 1. Problema

O Claude Code já tem onde guardar aprendizado — auto memory por projeto (`~/.claude/projects/<proj>/memory/`, índice `MEMORY.md`), skills pessoais (`~/.claude/skills/`, recarregadas sem reiniciar), `CLAUDE.md` — mas **falta o escritor**:

- a auto memory nativa salva pouco, só 4 tipos (user, feedback, project, reference), e por desenho ignora procedimentos e correções de debug — justamente o que o Hermes transforma em skill;
- não há loop de revisão: nada nativo revisa a sessão e cria/ajusta skills;
- resultado: o usuário repete as mesmas correções entre sessões.

O Hermes resolve com (a) gatilhos explícitos de salvamento no prompt, (b) uma revisão em background após cada turno, (c) skills como "memória procedural" refinadas por patches pontuais e (d) limites rígidos de tamanho que forçam consolidação. O Ouroboros reproduz isso como plugin.

## 2. Princípios

1. **Três camadas separadas**: *captura* (hooks determinísticos, sem LLM, baratos) → *reflexão* (LLM decide o que aprender) → *curadoria* (regras determinísticas decidem onde gravar, deduplicam, aplicam limites, registram). Custo e qualidade ficam controláveis em cada camada.
2. **Nada de LLM no caminho crítico** da sessão, exceto o nudge de revisão em momentos de alto sinal.
3. **Tudo reversível**: toda escrita tem origem, diff e undo.
4. **Limites rígidos** (como o Hermes): orçamento de contexto fixo; ao atingir 80%, consolidar.
5. **Medir antes de aprender**: a fase 1 só mede, para existir um baseline contra o qual provar valor.
6. **Aprender só de fontes confiáveis**: falas do usuário e resultados verificados — nunca de texto vindo de ferramentas (páginas web, saídas de comando), para evitar "envenenamento" por prompt injection.
7. **Zero dependências**: Node ≥ 22.13 (`node:sqlite` embutido), sem `npm install`. Funciona igual em Windows, macOS e Linux.

## 3. Arquitetura

```
Sessão do Claude Code
 ├─ SessionStart ─► injeta user.md (perfil global) + protocolo de aprendizado (gatilhos)
 │
 ├─ CAPTURA (hooks async, sem LLM) ───────────────────────► events.db (SQLite, WAL)
 │    UserPromptSubmit      correção / "lembre, sempre, nunca, a partir de agora"
 │    PostToolUse(Failure)  erro → recuperação; uso de skill; leitura de memória;
 │                          escrita em memória/skill (ledger por observação)
 │    UserPromptExpansion   /skill digitada (não passa pelo PostToolUse)
 │    PreCompact            marca sessão para revisão
 │
 ├─ REFLEXÃO A — no loop (Stop, síncrono)
 │    sinal alto + cooldown ok + !stop_hook_active  →  {"decision":"block", reason: roteiro}
 │    o próprio Claude revisa o turno com a skill `aprender` e grava (Write/Edit)
 │
 ├─ SessionEnd (≤1,5 s) ─► enfileira sessão + dispara worker destacado
 │
 └─ REFLEXÃO B — background (worker Node destacado)
      transcript → resumo compacto → `claude -p` (Haiku, JSON schema) → propostas
      → CURADOR (determinístico): dedupe vs inventário → create | patch | skip
      → roteamento → limites → grava → ledger → aviso na próxima sessão

Dashboard (node, 127.0.0.1) ◄── events.db + varredura de memórias/skills + usage dos transcripts
```

### 3.1 Onde cada coisa fica

| Conteúdo | Local | Por quê |
|---|---|---|
| Perfil global do usuário (equivalente ao `USER.md` do Hermes) | `~/.ouroboros/user.md` | Sobrevive a desinstalar/atualizar; editável à mão; injetado em toda sessão |
| Config avançada (roteamento, limites) | `~/.ouroboros/config.json` | Estruturas que `userConfig` não expressa bem |
| Telemetria + ledger | `${CLAUDE_PLUGIN_DATA}/events.db` | Estado do plugin; persiste entre updates |
| Fatos de projeto | auto memory nativa (`~/.claude/projects/<proj>/memory/*.md` + `MEMORY.md`), respeitando `autoMemoryDirectory` | Coopera com o mecanismo nativo em vez de competir |
| Skills aprendidas genéricas | `~/.claude/skills/learned-<nome>/SKILL.md` | Valem em todos os projetos; prefixo identifica a origem |
| Skills aprendidas de projeto | destino do mapa de roteamento (ex.: `nisus-*` → `~/source/repos/nisus-skills/...`) ou `.claude/skills/` do repo | Não vazam para outros projetos |

Toda memória/skill criada pelo Ouroboros leva no frontmatter:

```yaml
metadata:
  origin: ouroboros
  id: lrn_01J...          # chave no ledger
  confidence: 0.6        # 0.3 tentativo … 0.9 quase certo
  created: 2026-11-07
  trigger: correction     # correction | remember | recovery | long_task | repetition | review
```

## 4. Componentes do plugin

```
ouroboros/
├── .claude-plugin/
│   ├── plugin.json            # manifesto + userConfig
│   └── marketplace.json       # o repo é o próprio marketplace
├── hooks/hooks.json           # todos os hooks, exec form: node <dispatcher> <evento>
├── scripts/
│   ├── hook.mjs               # dispatcher único (um processo por evento)
│   ├── db.mjs                 # schema + migrations (node:sqlite)
│   ├── signals.mjs            # detecção de correção/pedido de lembrar (regex PT/EN)
│   ├── transcript.mjs         # leitura do JSONL → resumo compacto p/ o revisor
│   ├── review-worker.mjs      # reflexão B (claude -p) + chamada ao curador
│   ├── curator.mjs            # dedupe, roteamento, limites, escrita, ledger
│   └── paths.mjs              # resolução de memória nativa, skills, config
├── skills/
│   ├── aprender/SKILL.md      # roteiro de revisão (nudge e manual: /ouroboros:aprender)
│   ├── desfazer/SKILL.md      # reverte a última (ou uma) escrita
│   ├── esquecer/SKILL.md      # arquiva um aprendizado
│   └── dashboard/SKILL.md     # sobe o dashboard e abre o navegador
├── agents/curador.md          # subagente (modelo barato) p/ consolidação quando o orçamento estoura
├── dashboard/
│   ├── server.mjs             # http nativo, 127.0.0.1, API JSON
│   └── public/                # HTML/CSS/JS sem build; gráficos em SVG próprio
└── DESIGN.md
```

Sem pasta `bin/` (impede instalação via claude.ai/Cowork).

### 4.1 `userConfig`

| Chave | Tipo | Padrão | Uso |
|---|---|---|---|
| `autonomy` | string (`auto`/`hybrid`/`queue`) | `auto` | Política de escrita (§7) |
| `reviewer_model` | string | `haiku` | Modelo do revisor em background |
| `background_review` | boolean | `true` | Liga/desliga a reflexão B |
| `inloop_nudge` | boolean | `true` | Liga/desliga a reflexão A |
| `nudge_cooldown_min` | number | `20` | Intervalo mínimo entre nudges por sessão |
| `monthly_budget_usd` | number | `5` | Teto do revisor; ao estourar, reflexão B pausa até o mês seguinte |
| `language` | string | `pt-BR` | Idioma dos aprendizados e avisos |

### 4.2 `~/.ouroboros/config.json`

```json
{
  "routing": [
    { "match": "**/nisus-*", "skillsDir": "~/source/repos/nisus-skills/skills" }
  ],
  "limits": {
    "userProfileChars": 1500,
    "memoryIndexLines": 150,
    "learnedSkills": 30,
    "skillDescriptionChars": 250,
    "consolidateAt": 0.8
  },
  "archiveAfterDaysUnused": 60,
  "excludeProjects": []
}
```

## 5. Captura (hooks)

Todos em **exec form** (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs", "<evento>"]`) — sem problemas de aspas/shell no Windows. Hooks que só registram rodam com `async: true` (não bloqueiam a sessão). Guarda de recursão: se `OUROBOROS_REVIEWER=1` (sessões do próprio revisor), todo hook sai imediatamente.

| Evento | Matcher | Modo | O que faz |
|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact` | síncrono | Cria a sessão no DB; injeta `user.md` + protocolo (§6.1) + avisos pendentes do revisor ("📝 desde a última sessão aprendi: …"); varre fila órfã e redispara worker se necessário |
| `UserPromptSubmit` | — | async | Conta prompt; `signals.mjs` detecta correção/pedido de lembrar → evento com trecho |
| `UserPromptExpansion` | — | async | `/skill` digitada → `skill_used` |
| `PostToolUse` | `Skill` | async | `skill_used` (+ incrementa `uses` se for aprendida) |
| `PostToolUse` | `Read` | async | Leitura dentro de diretório de memória → `memory_read` |
| `PostToolUse` | `Write\|Edit` | async | Escrita em memória/skill → ledger por observação (pega também o que o Claude grava por conta própria) |
| `PostToolUse` | `*` | async | Conta tool calls; fecha sequência erro → sucesso no mesmo alvo como `recovery` |
| `PostToolUseFailure` | `*` | async | `tool_fail` com alvo (arquivo/comando normalizado) |
| `PreCompact` | `manual\|auto` | async | Marca sessão `needs_review` |
| `Stop` | — | **síncrono** | Decide o nudge (§6.2) |
| `SessionEnd` | — | síncrono, < 300 ms | Enfileira e dispara `review-worker.mjs` destacado (`spawn` com `detached`, `windowsHide`, `unref`) |

Meta de latência: hooks síncronos < 150 ms (dominado pelo start do Node), async não contam.

## 6. Reflexão

### 6.1 Protocolo injetado (o "system prompt" do Hermes, como contexto de sessão)

Injetado pelo `SessionStart`, curto (~600 caracteres), em vez de editar o `CLAUDE.md` do usuário — assim o plugin é autocontido e compartilhável:

> Ouroboros ativo. Sem precisar pedir, salve quando aprender: preferência do usuário, correção de abordagem, convenção do projeto, fato de ambiente. Crie ou ajuste uma skill quando: montar um workflow de vários passos reaproveitável; achar o caminho que funciona depois de erros; o usuário corrigir sua abordagem. Prefira ajustar o existente a criar novo. Não salve o que é derivável do código/CLAUDE.md nem o que é efêmero. Ao gravar, avise em 1 linha: "📝 aprendi: …". Detalhes: skill `ouroboros:aprender`.

### 6.2 Reflexão A — nudge no loop (Stop)

Dispara `{"decision":"block","reason": <roteiro>}` somente se **todas**:

- `stop_hook_active` é falso (evita loop);
- passou `nudge_cooldown_min` desde o último nudge na sessão;
- houve **sinal alto** desde o último nudge: `correction`, `remember`, `recovery`, ou ≥ 5 tool calls numa tarefa concluída (heurística do Hermes);
- o próprio Claude ainda não gravou nada desde o sinal (ledger por observação).

O `reason` cita os sinais concretos ("o usuário corrigiu: 'não, use pnpm'"; "3 falhas em `dotnet test` seguidas de sucesso") e manda executar a skill `aprender` de forma breve, terminando com "nada a aprender" se nada passar nos filtros. Custo medido pelo `usage` do transcript entre o nudge e o próximo `Stop`.

### 6.3 Reflexão B — revisor em background

1. **Gatilho**: `SessionEnd` (ou sessão `needs_review` órfã encontrada no próximo `SessionStart`). Ignora sessões com < 3 prompts ou já totalmente cobertas pelo nudge.
2. **Resumo**: `transcript.mjs` reduz o JSONL a falas do usuário, texto do assistente, nomes de ferramentas, erros e eventos marcados; teto ~20k tokens.
3. **Inventário**: títulos + descrições das memórias/skills existentes no escopo (para o modelo escolher `patch` em vez de `create`).
4. **Chamada**: `claude -p --model <reviewer_model> --output-format json` com JSON schema de saída, sem ferramentas, `cwd` em `${CLAUDE_PLUGIN_DATA}/reviewer` (para os transcripts do revisor não poluírem os projetos do usuário), `OUROBOROS_REVIEWER=1`.
5. **Saída**: lista de propostas `{kind, scope, op: create|patch, target?, title, body | patch, confidence, trigger, evidence, duplicates_learning?}`. O campo `duplicates_learning` indica "o usuário precisou repetir algo que já estava aprendido" → métrica de *miss* (§9).
6. **Custo**: `total_cost_usd` e tokens do resultado vão para `reviews`. Se o acumulado do mês ≥ `monthly_budget_usd`, o worker não roda.

### 6.4 Roteiro da skill `aprender` (usada por A e manualmente)

- Filtros de qualidade (Claudeception + Hermes): **descoberta real** (não foi só ler doc), **verificada** (funcionou), **reutilizável** ("ajudaria daqui a 6 meses?"), **não derivável** do código/CLAUDE.md, **não efêmera**, **fonte confiável** (fala do usuário ou resultado observado).
- Classificar: fato → memória (tipo nativo `user|feedback|project|reference`; perfil global → `user.md`); procedimento → skill.
- Sempre checar o existente antes; preferir patch pontual.
- Formato de memória idêntico ao da auto memory nativa (frontmatter `name/description/metadata.type` + linha no `MEMORY.md`), acrescido de `metadata.origin/id/confidence`.

## 7. Curadoria e política de escrita

Decisão do dono: **`autonomy = auto`** (como o Hermes). Consequências:

- Proposta que passa nos filtros é gravada direto; aviso de 1 linha na sessão (A) ou na próxima sessão (B).
- **Undo é obrigatório desde a primeira escrita**: `/ouroboros:desfazer` e botão no dashboard revertem pelo diff do ledger.
- Confiança baixa (< 0,5) entra mesmo assim, mas é a primeira a ser arquivada se não for usada.
- Os modos `hybrid`/`queue` ficam implementados como opção para quem instalar o plugin (fila no dashboard).

Passos do curador (`curator.mjs`, determinístico):

1. **Validar** schema e tamanho.
2. **Dedupe**: similaridade lexical (trigramas, Jaccard ≥ 0,6) contra o inventário do escopo → converte `create` em `patch` ou descarta.
3. **Rotear**: escopo `global` → `user.md` ou `~/.claude/skills/learned-*`; `project` → memória nativa do projeto ou `routing[].skillsDir`; sem regra → `.claude/skills/` do repo.
4. **Limites**: se a escrita passar de 80% de qualquer orçamento → dispara consolidação (subagente `curador`: funde parecidos, encurta, arquiva os de menor `confidence × uso`). Acima de 100%, a escrita só entra após consolidar.
5. **Gravar** (atomicamente: arquivo temporário + rename) e registrar em `writes` com diff.
6. **Aviso** pendente para a próxima sessão.

### 7.1 Ciclo de vida

```
proposta ─► ativo (conf. 0,3–0,9) ─► reforçado (+0,1 por uso; +0,2 se o usuário confirmar)
                     │
                     ├─► arquivado (60 dias sem uso, ou consolidado em outro)
                     └─► revertido (undo do usuário; conta como sinal negativo p/ o revisor)
```

Arquivar = mover para `~/.ouroboros/archive/` (fora do contexto), nunca apagar.

## 8. Modelo de dados (`events.db`)

```sql
sessions  (id, project, cwd, started_at, ended_at, prompts, tool_calls,
           needs_review, reviewed_at, is_reviewer)
events    (id, session_id, ts, kind, payload_json)
          -- kind: prompt | correction | remember | tool_fail | recovery | long_task
          --       | skill_used | memory_read | nudge | compact | session_end
learnings (id, kind, scope, project, path, title, confidence, status,
           trigger, origin_session, created_at, updated_at, uses, last_used_at)
          -- status: active | archived | reverted
writes    (id, learning_id, ts, op, actor, session_id, diff)
          -- op: create | patch | archive | revert ; actor: inloop | background | manual | native
reviews   (id, session_id, mode, model, input_tokens, output_tokens,
           cache_tokens, cost_usd, proposals, applied, ts)
nudges    (id, session_id, ts, signals_json, outcome, tokens)
```

WAL + `busy_timeout` para várias sessões simultâneas. Migrations versionadas em `db.mjs`.

## 9. Dashboard

`/ouroboros:dashboard` sobe `node dashboard/server.mjs` em `127.0.0.1:4747` (porta configurável) e abre o navegador. HTML/JS sem build, gráficos em SVG próprio, tema claro/escuro. API local protegida por token gerado no start (evita que outra página do navegador chame os endpoints).

### 9.1 Telas

| Tela | Conteúdo |
|---|---|
| **Visão geral** | KPIs da semana: aprendizados novos, taxa de aproveitamento, taxa de correção vs baseline, custo do mês vs teto; linha do tempo das últimas escritas |
| **Inventário** | Todas as memórias/skills (aprendidas e nativas), filtro por escopo/projeto/tipo/status; confiança, usos, último uso; ações: ver diff, editar, arquivar, desfazer |
| **Valor** | Correções por sessão ao longo do tempo (com marca de quando o aprendizado foi ligado); *misses*; sessões com ≥ 1 aprendizado usado |
| **Custo** | Revisor (US$ e tokens por dia), nudges (tokens), overhead fixo de contexto; projeção do mês |
| **Saúde** | Barras de orçamento (user.md, MEMORY.md, nº de skills, listagem de skills), itens parados, duplicatas suspeitas, erros de hooks/worker |

### 9.2 Métricas (definições)

| Métrica | Definição |
|---|---|
| Taxa de correção | `correction` ÷ prompts, média móvel de 7 dias. **Indicador principal de valor**: deve cair vs baseline |
| Misses | Propostas com `duplicates_learning` — o usuário precisou repetir algo já aprendido (memória falhou: não carregou, descrição ruim, ou foi ignorada) |
| Taxa de aproveitamento | Aprendizados ativos com ≥ 1 uso nos últimos 30 dias ÷ ativos |
| Hits | Sessões com ≥ 1 `skill_used`/`memory_read` de item aprendido |
| Custo do revisor | Σ `reviews.cost_usd` (em assinatura, é equivalente de cota, não cobrança extra) |
| Custo do nudge | Σ tokens do assistente entre o nudge e o `Stop` seguinte |
| Overhead fixo | (chars de `user.md` + protocolo + linhas do `MEMORY.md` + descrições de skills aprendidas) ÷ 4 × sessões |
| Custo por hit | (revisor + nudge + overhead) ÷ hits |

## 10. Distribuição

- Repositório GitHub (privado por enquanto) que é o próprio marketplace (`.claude-plugin/marketplace.json`).
- Instalação: `/plugin marketplace add lucamartins/ouroboros` → `/plugin install ouroboros@ouroboros`.
- `claude plugin validate --strict` no CI.
- Requisito declarado: Node ≥ 22.13 no PATH. O `SessionStart` checa a versão e, se faltar, avisa uma vez e desativa os hooks silenciosamente.

## 11. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Poluição de memória (modo auto) | Filtros de qualidade, dedupe, limites rígidos com consolidação, arquivamento por desuso, undo |
| Loop infinito no `Stop` | `stop_hook_active`, cooldown, no máximo N nudges por sessão |
| Latência | Captura async; um único processo Node por evento; LLM fora do caminho crítico |
| `SessionEnd` com 1,5 s | Só enfileira e dispara worker destacado; fila órfã reprocessada no próximo `SessionStart` |
| Recursão (o revisor dispara hooks) | `OUROBOROS_REVIEWER=1` desliga tudo; `cwd` separado; sessões marcadas `is_reviewer` fora das métricas |
| Prompt injection ensinando o agente | Só aprende de falas do usuário e resultados observados; texto de ferramentas nunca vira aprendizado literal |
| Vazamento entre projetos | Roteamento por escopo; `excludeProjects` |
| Dados sensíveis gravados | Filtro de segredos (padrões de token/chave/senha) antes de qualquer escrita; dashboard só em `127.0.0.1` |
| Orçamento da listagem de skills (~1% do contexto) | Limite de nº de skills aprendidas e de tamanho da descrição; métrica na tela Saúde |
| Custo do revisor | Haiku, resumo compacto do transcript, teto mensal, pular sessões curtas ou já cobertas pelo nudge |

## 12. Decisões tomadas

| Decisão | Escolha |
|---|---|
| Nome | `ouroboros` |
| Autonomia | Automático total (como o Hermes); `hybrid`/`queue` disponíveis como opção |
| Reflexão | Ambas: nudge no `Stop` em sinal alto + revisor em background (Haiku) |
| Destino das skills | Roteamento automático (global vs projeto, com mapa por repositório) |
| Repositório | GitHub privado por enquanto |
| Runtime | Node ≥ 22.13, zero dependências |

## 13. Fases

| Fase | Entrega | Critério de pronto |
|---|---|---|
| **1. Medir** | Captura completa, `events.db`, dashboard só leitura (Visão geral, Inventário, Saúde) | 1–2 semanas de baseline de correções/misses; hooks sem latência perceptível |
| **2. Aprender manual** | Skill `aprender`, curador, ledger, `desfazer`/`esquecer`, `user.md` + protocolo no `SessionStart` | `/ouroboros:aprender` grava, deduplica, roteia e desfaz corretamente |
| **3. Aprender sozinho** | Nudge no `Stop`, worker em background, avisos, telas Valor e Custo | Taxa de correção cai vs baseline com custo dentro do teto |
| **4. Ciclo de vida e distribuição** | Confiança/decay, consolidação automática, ações no dashboard, marketplace, `validate --strict` no CI, README | Outra pessoa instala do zero no Windows e no macOS |

## 14. Perguntas em aberto

1. Regex de correção em PT/EN basta, ou vale um classificador Haiku opcional (custo extra por prompt)?
2. `user.md` deve ser só perfil (como o `USER.md` do Hermes) ou também notas globais do agente (como o `MEMORY.md` do Hermes)? Proposta inicial: dois blocos no mesmo arquivo, com orçamentos separados.
3. Revisor deve ler também sessões de subagentes/workflows, ou só a sessão principal?
4. Painel dentro do Claude Code (mod/status line com "📝 3 aprendizados nesta sessão") além do dashboard web?
