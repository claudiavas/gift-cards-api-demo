# 🎁 Gift Cards API

API REST que automatiza la entrega de recompensas (referidos, promociones, fidelización...): genera tarjetas regalo de Amazon, las encripta, las entrega por email y deja una pista de auditoría inmutable.

**🚀 Demo interactiva en vivo:** <https://gift-cards-api-production.up.railway.app>

> La demo hace peticiones HTTP reales a esta API. Amazon, el CRM y SendGrid están simulados (`DEMO_MODE`): los códigos son ficticios y no se envía ningún email real. La base de datos sí es real: PostgreSQL en Railway.

## El problema

Una empresa recompensa a sus clientes con tarjetas regalo de Amazon (por un referido, una promoción, un programa de fidelización...). Hacerlo a mano no escala y tiene un riesgo serio: **un código de tarjeta regalo es dinero al portador**. Cualquiera que lo vea —en la base de datos, en un log, en un email interno— puede canjearlo.

Esta API resuelve ambas cosas: automatiza el flujo completo (CRM → Amazon → email) y garantiza que **el código nunca existe en plaintext** fuera de la memoria del proceso. Antes de generar nada, valida contra el CRM de origen (cualquiera con API HTTP: Zoho, HubSpot, Salesforce, un backoffice propio) que el contacto es un cliente elegible; cada recompensa llega identificada por un `rewardId` único que actúa como clave de idempotencia.

## Arquitectura

```text
Cualquier CRM / backoffice (scheduler diario o botón manual)
      │  POST /gift-cards/process
      ▼
┌─────────────────────────────────────────────┐
│  API Node.js + Express                      │
│  ├─ Auth por API key + rate limiting       │
│  ├─ Idempotencia por rewardId              │
│  ├─ Amazon Incentives API (AWS SigV4)      │
│  ├─ Encriptación AES-256-GCM inmediata     │
│  ├─ PostgreSQL (solo códigos encriptados)  │
│  ├─ SendGrid (email al destinatario)       │
│  └─ Auditoría append-only (inmutable)      │
└─────────────────────────────────────────────┘
```

- **Backend:** Node.js + Express
- **BD:** PostgreSQL (códigos siempre encriptados; UNIQUE constraints = idempotencia garantizada por la BD)
- **Auditoría:** tabla append-only en PostgreSQL (el rol de la app solo INSERT, el auditor solo SELECT)
- **Email:** SendGrid con plantillas dinámicas
- **Autenticación con Amazon:** AWS Signature V4
- **Encriptación:** AES-256-GCM
- **Infra:** Docker, Railway (demo en vivo) / Cloud Run, GitHub Actions (CI)

## Decisiones de seguridad

1. **Encriptación inmediata** — el código se encripta en el instante en que Amazon lo devuelve; solo se desencripta en memoria justo antes de componer el email, y la variable se anula después.
2. **Sanitización de logs** — un middleware redacta códigos de tarjeta, claves AWS, tokens y emails de todo lo que va a los logs (patrones regex, testeado).
3. **Idempotencia** — un `creationRequestId` único y un constraint por `rewardId` garantizan que un reintento del scheduler nunca genere (ni pague) dos tarjetas.
4. **Auditoría independiente** — el log de accesos es inmutable; la empresa audita qué pasó con cada código sin depender del desarrollador.
5. **Rate limiting** — límites por API key/IP y reglas de reenvío: máximo 1/hora, 3/día, 5 en total por tarjeta.
6. **Manejo de errores de Amazon** — F300 (fondos), F400 (temporal), etc. se traducen a estrategias distintas: backoff exponencial, alerta al CRM o fallo controlado.

## Decisiones y trade-offs

**¿Por qué PostgreSQL?** El workload es OLTP puro: pocas filas, búsquedas puntuales por `rewardId`, y una regla de negocio que debe ser inviolable — una recompensa, una tarjeta. Los constraints `UNIQUE (reward_id)` y `UNIQUE (creation_request_id)` hacen que la idempotencia la garantice la base de datos, no la aplicación: dos requests concurrentes con el mismo reward no pueden generar (ni pagar) dos tarjetas, sin race conditions posibles. Una base analítica (BigQuery, etc.) no impone constraints y penaliza los UPDATE; aquí sería la herramienta equivocada.

**¿Por qué proveedores concretos y no abstracciones?** Amazon Incentives, SendGrid y PostgreSQL están acoplados a propósito: las peculiaridades reales (AWS SigV4 con reloj NTP, códigos de error F-xxx, `ON CONFLICT`) son donde vive la ingeniería. Pero cada proveedor está aislado en su propio servicio (`amazon.js`, `sendgrid.js`, `db.js`), así que cambiar uno es tocar un archivo. El CRM sí es genérico (`crm.js`) porque es quien llama a la API, no una dependencia interna.

**Auditoría inmutable por permisos** — la tabla `access_logs` es append-only: en producción el rol de la aplicación solo tiene `INSERT` y el rol auditor solo `SELECT` (ver [`sql/create_tables.sql`](sql/create_tables.sql)). Ni siquiera el desarrollador puede reescribir la historia.

## Despliegue

- **Demo en vivo:** [Railway](https://railway.com) — servicio Node + PostgreSQL gestionado, con `DEMO_MODE=true`. Los datos de la demo persisten de verdad en Postgres (se purgan a los 7 días).
- **Producción:** cualquier plataforma de contenedores — el `Dockerfile` multi-stage funciona igual en Cloud Run, Railway o Fly.io. CI con GitHub Actions ([`.github/workflows/`](.github/workflows/)).

## Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/health` | Health check (público) |
| `POST` | `/gift-cards/process` | Generar y enviar tarjeta (idempotente: reenvía si ya existe) |
| `POST` | `/gift-cards/resend` | Reenviar tarjeta existente (límites 1/h, 3/día, 5 total) |
| `GET` | `/gift-cards/demo/records` | _(solo demo)_ Registros almacenados — códigos encriptados |
| `GET` | `/gift-cards/demo/audit` | _(solo demo)_ Log de auditoría |
| `GET` | `/gift-cards/demo/last-email` | _(solo demo)_ Último email simulado |

Todas las rutas `/gift-cards/*` requieren cabecera `x-api-key`.

## Ejecutar en local

```bash
npm install

# Modo demo: sin credenciales, todo simulado
DEMO_MODE=true npm start
# → abre http://localhost:3000 (demo interactiva)

# Modo real: copiar .env.example a .env y configurar credenciales
cp .env.example .env
npm run dev
```

```bash
npm test          # 20 tests unitarios (encriptación, sanitización, rate limiting)
```

## Estructura

```text
src/
├── index.js              # Bootstrap Express, auth, error handling
├── middleware/
│   ├── rateLimit.js      # Rate limiting + reglas de reenvío
│   └── sanitizer.js      # Redacción de datos sensibles en logs
├── routes/
│   └── giftCards.js      # Endpoints process / resend / demo
├── services/
│   ├── amazon.js         # Amazon Incentives API (AWS SigV4, reintentos)
│   ├── db.js             # PostgreSQL: persistencia + auditoría (fallback in-memory)
│   ├── sendgrid.js       # Email (simulado en demo)
│   └── crm.js            # Integración genérica con el CRM de origen
└── utils/
    ├── encryption.js     # AES-256-GCM
    └── logger.js         # Logging estructurado + sanitizado
```

---

Proyecto diseñado, implementado y documentado por **Claudia Vásquez** ([claudia.vasquez.as@gmail.com](mailto:claudia.vasquez.as@gmail.com)). El plan de implementación completo (4 semanas, sprints con scoring fibonacci) está en [`docs/`](docs/).
