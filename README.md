# Axios Backend

Express API, AI orchestration engine, and data layer for the Axios AI screening platform.

---

## Responsibility

The backend is the system-of-record and AI decision layer. It handles:

- Identity, authentication, and JWT session management
- Multi-tenant company data isolation
- Job and candidate lifecycle management
- File ingestion pipelines (CSV, Excel, PDF)
- AI screening orchestration via Gemini API
- Deterministic fallback scoring when AI quota is constrained
- Screening result persistence with full explainability metadata
- Shortlist email dispatch via SMTP

---

## Stack

| | |
|---|---|
| Runtime | Node.js (CommonJS) |
| Framework | Express |
| Database | MongoDB via Mongoose ODM |
| AI / LLM | Google Gemini (`@google/generative-ai`) |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` |
| File Handling | Multer, `pdf-parse`, `xlsx`, `csv-parser` |
| File Storage | Cloudinary |
| Email | Nodemailer (SMTP) |
| Security | `helmet`, `express-rate-limit`, `express-validator` |

---

## Architecture

```
Next.js Frontend
      │
      │ JWT Bearer + REST
      ▼
Express API
  ├── /api/auth          Identity and session
  ├── /api/company       Onboarding and company context
  ├── /api/jobs          Job lifecycle (CRUD)
  ├── /api/candidates    Ingestion and candidate management
  ├── /api/screening     AI evaluation and ranked results
  ├── /api/emails        Shortlist communication
  ├── /api/dashboard     Company-scoped metrics
  └── /api/config        Constants (industries, departments)
      │
      ├── MongoDB Atlas   Persistence
      ├── Gemini API      AI scoring and reasoning
oudinary      Resume file storage
      └── SMTP            Email dispatch
```

---

## Domain Model

### User
Identity record. Linked to one `Company` after onboarding.

### Company
Org profile including industry, size, departments, hiring philosophy, and tech stack. This context is injected into every AI screening prompt to calibrate results to the company's actual hiring standards.

### Job
Role definition with scoring weights, shortlist target size, and status. Always scoped to a company.


Normalized applicant profile linked to a specific job. Created from structured uploads or parsed from CSV/PDF.

### ScreeningResult
Per-candidate AI evaluation output: score (0–100), rank, strengths, weaknesses, recommendation, and `evaluationMode` (AI or fallback). Linked to both job and candidate.

---

## AI Screening Pipeline

1. Validate requester and company ownership
2. Load job definition and all linked candidates
3. Reject if candidate list is empty
tes
5. Select candidate pool for Gemini refinement
6. Run Gemini in controlled batches with cooldown between batches
7. Merge AI results with fallback scores
8. Sort, rank, and mark shortlisted candidates
9. Persist results with full explainability fields
10. Return recruiter-ready output

### Company Context in Prompts

Every Gemini prompt includes the company's hiring philosophy, industry, departments, and tech stack. This means:
- A research-heavy org gets candidates evaluated on academic depth
s candidates evaluated on shipping speed
- A non-technical company gets candidates evaluated on business skills

This is what makes Axios screening contextually relevant rather than generic.

### Resilience

- Company-level screening lock prevents concurrent collision
- Configurable batch sizes and inter-batch delays
- Cached result reuse when job/candidate state is unchanged
- Graceful local fallback when Gemini quota is unavailable
- `evaluationMode` field on every result maintains transparency

---

tion Design

### CSV / Excel
- Raw rows parsed locally
- AI-assisted column mapping for unknown schemas
- Normalized candidate records persisted in bulk

### PDF Resumes
- Text extracted and normalized
- Optional Cloudinary storage for file reference
- AI parsing into unified candidate object before persistence

---

## Security Model

- JWT required on all protected endpoints
- Decoded user loaded from DB and attached to request context
- Ownership checks on every entity access path
nied with `403`
- `helmet` security headers enabled globally
- Rate limiting on all `/api/*` routes
- Onboarding endpoint enforces one-time company creation (blocks duplicate setup with `409`)

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb+srv://...
JWT_SECRET=your-strong-secret

CORS_ORIGIN=http://localhost:3000

GEMINI_API_KEY=your-gemini-key

# Optional — email dispatch
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=


# Optional — resume storage
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

---

## Local Development

```bash
npm install
npm run dev
```

API runs at `http://localhost:5000/api`.

---

## Production Deployment

Recommended:
- **Backend**: Render / Railway / Fly.io
- **Database**: MongoDB Atlas
- **Frontend**: Vercel

Hardening checklist:
- Set a strong `JWT_SECRET` (32+ random characters)
- Set `CORS_ORIGIN` to exact deployed frontend URL
- Kg only
- Set `NODE_ENV=production`

---

## Hackathon Requirement Mapping

| Requirement | Implementation |
|---|---|
| Gemini as mandatory LLM | `@google/generative-ai` in screening pipeline |
| Multi-candidate evaluation | Batch Gemini prompts per job |
| Ranked shortlist (Top 10/20) | Configurable per job at creation |
| Strengths, gaps, recommendation | Structured fields on every `ScreeningResult` |
| Structured profile ingestion | CSV/Excel pipeline |
| External resume ingestion | PDF parse pipeline |
| Recruiter final control | AI is advisory; recruiter triggers and decides |
| Explainable AI output | `evaluationMode` + reasoning fields on all results |

---

## Known Gaps / Future Work

- Automated integration tests for auth and tenancy boundaries
- Background job queue for very large batch screening operations
- RBAC model (Admin / Recruiter / Viewer) for team-based access
- Webhook support for real-time screening progress updates
