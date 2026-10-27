# Rebuild Log - Backend API Only

Date: 2026-10-25

## Reorganization
- Created `backend/` and `frontend/` folders at project root.
- Moved the entire existing Django project (including TaskQue engine) into `backend/`.
- `frontend/` left as placeholder for the future React app.

## Backend Cleanup
- Removed inactive/unused apps and modules:
  - `live/` app.
  - `api/cadets __/`, `api/courses/`, `api/library/`.
- Removed all HTML/templates and frontend assets:
  - `templates/` directory.
  - `static/` collected static.
  - `static_src/` frontend source.
  - Root HTML files (`gv_ingest_recorder.html`, `test.html`, `test2.html`).
- Removed generated/unused artifacts:
  - `models_from_db.py`, `TEST.PNG`, duplicate `gitignore`.
  - Empty `records/views.py`, `accounts/forms.py`, `accounts/views.py`, `accounts/urls.py`.
- Cleaned `__pycache__` directories.

## API-Only Conversion
- `core/urls.py`: removed template routes (`signin`, `dashboard`, `trap`, accounts urls); kept `api/` and admin.
- `accounts`: removed template-based views/forms/urls; models retained.
- `core/settings.py`:
  - INSTALLED_APPS: removed live; added `corsheaders`.
  - MIDDLEWARE: added CORS middleware.
  - TEMPLATES DIRS emptied; APP_DIRS kept for admin.
  - STATICFILES_DIRS emptied; STATIC_ROOT defaults to `backend/staticfiles`.
  - Default permission class changed from AllowAny to IsAuthenticated.
  - EXCLUDED_PERMS cleaned of non-existent records permissions.
  - Added CORS settings (allow all origins in DEBUG, credentials enabled).
- `api/urls.py`: removed commented inactive routes; added auth endpoints (`auth/login/`, `auth/logout/`, `auth/me/`).
- `api/views.py`:
  - Added `LoginView`, `LogoutView`, `CurrentUserView`.
  - Enforced `IsAuthenticated` on recording/user/role endpoints.
  - Kept `record_cron/<pk>/` as AllowAny for TaskQue.
- Added `django-cors-headers` to `requirements.txt`.

## Preserved Contracts
- All recording API contracts from PROJECT_REPORT.md preserved.
- TaskQue engine (`TaskQue/`) left unchanged (fixed instructions intact).
- Database models and migrations retained.

## Drawbacks Addressed
- Recording endpoints now require authentication (except TaskQue cron endpoint).
- Password change endpoint now requires authentication.
- Removed unused inactive modules and templates.
- Added CORS support for future React frontend.
- Cleaned EXCLUDED_PERMS of stale entries.

## TaskQue v6 (Secured)
- Created `backend/TaskQue/mainscriptv6.py` (v5 preserved).
- Added shared service token (`TASKQUE_SERVICE_TOKEN`) loaded from env/`.env`.
- TaskQue now sends `X-Service-Token` on all Django HTTP calls (recordings fetch, record_cron patch).
- TaskQue WebSocket command handler rejects commands without a valid token.
- Django `send_command_to_pyqt` now includes the service token in every payload.
- Backend `record_cron/<id>/` now requires the service token; `recordings/` list allows authenticated users or the service token.

## Remaining / Notes
- Token/JWT auth not added for browser users; session + CSRF used. React must send credentials and CSRF token.
- No automated tests added.
