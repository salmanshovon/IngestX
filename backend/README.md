# IngestX Backend (Django API)

API-only Django backend for the React frontend (to be developed in `../frontend`).

## Run
```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

## Key Endpoints
- Auth: `/api/auth/login/`, `/api/auth/logout/`, `/api/auth/me/`
- Users/Roles: `/api/userlist/`, `/api/role_permissions/`, ...
- Recordings: `/api/record_ports/`, `/api/recordings/`, `/api/start_record/`, `/api/stop_record/`, `/api/record_cron/<id>/`

TaskQue desktop engine remains in `TaskQue/` and is unchanged.
