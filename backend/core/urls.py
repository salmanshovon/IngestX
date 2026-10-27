from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
import os
from dotenv import load_dotenv

load_dotenv()

from django.http import JsonResponse
from django.urls import re_path

urlpatterns = [
    re_path(r'^healthz/?$', lambda request: JsonResponse({'status': 'ok'}), name='healthz'),
    path(os.getenv('ADMIN_URL', 'admin/'), admin.site.urls),
    path('api/', include('api.urls')),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT) + static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
