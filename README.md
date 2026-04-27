# Tracker V1

Esse é o meu sistema de rastreamento de leads e conversões, hospedado no meu próprio Cloudflare. Criei ele porque queria parar de depender de ferramentas de terceiros caras e ter controle total sobre os dados de quem entra nas minhas páginas.

## O que ele faz

Quando alguém acessa uma página minha, o sistema:

1. **Captura a origem do visitante** — de onde ele veio, qual campanha, qual anúncio (UTMs, fbclid, gclid)
2. **Gera cookies próprios** que duram 400 dias e sobrevivem ao bloqueio do Safari — então não perco o rastro do lead mesmo em iPhone
3. **Dispara o evento para o Meta de forma server-side** — pelo servidor, não só pelo pixel do navegador. Isso significa que mesmo quem usa bloqueador de anúncio é contabilizado
4. **Salva o lead no banco** com nome, e-mail e WhatsApp para eu consultar no dashboard

O resultado: a Meta recebe os eventos com muito mais qualidade, o que melhora a otimização das campanhas.

## Por que fiz assim

O problema com o pixel padrão do Meta é que ele roda no navegador do visitante. Se a pessoa usa iPhone (Safari ITP), bloqueador de anúncio ou extensão de privacidade, o evento se perde. Isso distorce os dados e prejudica o algoritmo de otimização.

A solução profissional para isso normalmente envolve ferramentas como Stape ou GTM Server-Side, que custam mensalidade e dependem de infraestrutura de terceiros. Aqui eu montei a mesma solução rodando na minha própria conta do Cloudflare, sem custo adicional e sem nenhum dado passando por servidor de terceiros.

## Estrutura

- **Landing page** em `/landing_page` — formulário de captura com design gold/luxo
- **Dashboard** em `/dash` — visualizo todos os leads com nome, e-mail e telefone
- **Rastreamento server-side** — eventos enviados diretamente ao Meta CAPI com deduplicação (o pixel do navegador e o servidor disparam o mesmo evento_id, o Meta conta só uma vez)
- **Banco de dados D1** no Cloudflare — todos os leads ficam no meu próprio banco, sem terceiros

## Como funciona por baixo

Quando alguém acessa a landing page:

1. O middleware roda na borda (edge) do Cloudflare e gera/atualiza os cookies de rastreamento
2. O pixel do Meta dispara no navegador (PageView)
3. Simultaneamente, o servidor dispara o mesmo evento para a Meta CAPI — deduplicado
4. Quando o formulário é enviado, o servidor recebe nome, e-mail e telefone, hasheia os dados e os envia ao Meta para Advanced Matching, e salva o lead no banco

## Dashboard

Acesso em `/dash?key=MINHA_CHAVE`. Mostra:

- Total de leads no período
- Quantos têm e-mail e quantos têm WhatsApp
- Tabela com nome, e-mail, telefone, origem e status do envio ao Meta
- Clico em qualquer lead para ver exatamente o que foi enviado ao Meta e a resposta

## Stack

- **Cloudflare Pages** — hospedagem e edge functions
- **Cloudflare D1** — banco de dados SQLite no edge
- **Meta Conversions API** — eventos server-side
- **GitHub** — controle de versão e deploy automático (push = deploy)

## Deploy

O deploy é automático: qualquer push para a branch `main` no GitHub atualiza o site automaticamente via Cloudflare Pages.
