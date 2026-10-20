# Putting the deployment behind Cloudflare Access

The organization is a control plane: it holds goals, runs agents, and can
make things happen. It should not be reachable by anyone who guesses the
hostname.

There are two layers, and the deployment uses both.

## The edge: Cloudflare Access

Cloudflare can put an authentication gate in front of a Worker. **Worker-level
Access** protects a Worker by its script id, which covers its `workers.dev`
hostname, its routes, any custom domain and its preview URLs — no custom
domain, and no change to `wrangler.jsonc`.

Access is deny by default: a request has to match an Allow policy before it
is let through, and it is checked *before* the Worker runs. An
unauthenticated visitor never reaches the application at all.

### Applying it

The dashboard does it in two clicks: **Workers & Pages → incorporeal →
Access → "Protect this Worker behind Access"**, then pick the policy
(Cloudflare account member, or an email address) and apply.

The script does the same thing with an API token:

```sh
CLOUDFLARE_API_TOKEN=… node scripts/access-setup.mjs --email you@example.com
```

The token needs `Access: Apps and Policies Write` and `Workers Scripts:
Read`. The script prints the application's **aud** tag, which is what a
client asserts the token against.

### Who may sign in

Two policies the Workers documentation offers, and both fit a
single-operator deployment:

- **Cloudflare account** — members of the account may sign in with their
  Cloudflare credentials.
- **Email address** — one address, or a domain.

Access works on the Free plan. A user consumes a seat when they authenticate;
service tokens do not.

### The webhook sender

A machine calling a gated application presents an Access **service token**:

```
CF-Access-Client-Id: <id>
CF-Access-Client-Secret: <secret>
```

Create one with `POST /accounts/{account_id}/access/service_tokens` (or in
the dashboard) and add a **Service Auth** policy to the application. The
existing `X-Webhook-Secret` can stay as well; the two are independent.

## The application: the identity, and the token

When Access authenticates a request, the Worker can ask who it was:

```ts
const identity = await ctx.access?.getIdentity();
// → { email, name, user_uuid, … } for a person
// → no email for a service token: a machine
```

`ctx.access` is `undefined` when Access did not authenticate the request.
That is treated as a **denial**, never as an allow.

The management API requires its bearer token **as well**. The two layers
answer different questions:

| Layer | Question |
| --- | --- |
| Cloudflare Access | Is this an authenticated human (or a known machine)? |
| The management token | Is this an authorized management client? |

A mistake in one policy should not grant the rights of the other, so both
have to agree. `CF_ACCESS_ALLOWED_EMAILS` narrows it further: when Access
asserts an email, that email has to be on the list.

```
CF_ACCESS_ALLOWED_EMAILS=you@example.com
```

### The identity is what gets recorded

When a request changes something — approving a task, storing a credential —
the application records **who did it**. A verified Access identity wins over a
name in the request body: the identity provider asserted the email, and
anyone holding the management token can claim any name they like.

So an approval records the operator's verified address rather than a free
string.

## Locally

The development server pretends to be an authenticated operator, so the same
path is exercised without a Cloudflare account:

```jsonc
"access": {
  "dev": {
    "aud": "incorporeal-dev",
    "identity": { "email": "operator@localhost" }
  }
}
```

## Two things to know

1. **`ctx.access` is not propagated through Durable Object RPC.** It is
   available on the Worker's own request context, which is where the ingress
   is — so the identity is read at the edge, in the Worker, and passed to the
   agents as part of the request they are answering.
2. **Worker-level Access does not support WebSockets.** This application
   does not use them. If a realtime channel is ever added, protect the
   Worker with a hostname-based Access application instead.
