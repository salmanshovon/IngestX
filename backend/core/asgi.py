import os
from django.core.asgi import get_asgi_application
from django.contrib.staticfiles.handlers import ASGIStaticFilesHandler
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')

# Serve static files (Django admin CSS/JS, etc.) under Daphne in dev/LAN.
django_asgi_app = ASGIStaticFilesHandler(get_asgi_application())

import api.routing

application = ProtocolTypeRouter({
    'http': django_asgi_app,
    'websocket': AuthMiddlewareStack(
        URLRouter(api.routing.websocket_urlpatterns)
    ),
})