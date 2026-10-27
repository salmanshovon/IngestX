import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser


class RecordingConsumer(AsyncWebsocketConsumer):
    GROUP = 'recordings'

    async def connect(self):
        user = self.scope.get('user')
        if user is None or isinstance(user, AnonymousUser) or not user.is_authenticated:
            await self.close(code=4001)
            return
        await self.channel_layer.group_add(self.GROUP, self.channel_name)
        await self.accept()
        await self.send(text_data=json.dumps({
            'type': 'connection.established',
            'payload': {'user': user.username},
        }))

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(self.GROUP, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        # Optional client messages (ping)
        try:
            data = json.loads(text_data or '{}')
        except json.JSONDecodeError:
            data = {}
        if data.get('type') == 'ping':
            await self.send(text_data=json.dumps({'type': 'pong'}))

    async def recording_event(self, event):
        await self.send(text_data=json.dumps(event['data']))