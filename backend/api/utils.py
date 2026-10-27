import random
from django.core.mail import EmailMessage
from django.utils.html import strip_tags
from django.conf import settings
from datetime import date
from email.utils import formataddr
import socket
import logging
import json
import asyncio
import websockets

logger = logging.getLogger(__name__)


def generate_random_numeric_password(length=6):
    """Generate a random numeric password of given length (default: 6 digits)"""
    digits = [str(i) for i in range(10)]  # ['0', '1', ..., '9']
    return ''.join(random.choice(digits) for _ in range(length))


def send_welcome_email(email, username, temp_password):
    """
    Sends a beautifully crafted welcome email for  - Live Management System
    with username and temporary password for a newly created user account.
    Returns (success: bool, error_message: str)
    """
    subject = "Welcome to StreamX - Your Account Credentials"

    # HTML content of the email with a professional and elegant design
    html_content = f"""
    <html>
    <head>
        <style>
            body {{
                font-family: 'Segoe UI', Arial, sans-serif;
                background-color: #f0f4f8;
                margin: 0;
                padding: 0;
                line-height: 1.6;
            }}
            .email-container {{
                max-width: 650px;
                margin: 40px auto;
                background-color: #ffffff;
                border-radius: 12px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
                padding: 40px;
                color: #2d3748;
            }}
            .header {{
                text-align: center;
                font-size: 28px;
                font-weight: 700;
                color: #1a4971;
                margin-bottom: 25px;
                border-bottom: 2px solid #e6ecf0;
                padding-bottom: 15px;
            }}
            .credentials-box {{
                background-color: #f1f9ff;
                border-left: 5px solid #2b6cb0;
                padding: 20px;
                margin: 25px 0;
                font-size: 16px;
                color: #1a4971;
                border-radius: 6px;
            }}
            .credential-item {{
                margin-bottom: 10px;
                display: flex;
            }}
            .credential-label {{
                font-weight: 600;
                min-width: 120px;
            }}
            .password {{
                font-size: 20px;
                font-weight: 600;
                letter-spacing: 1px;
                text-align: center;
                margin-top: 15px;
                padding: 10px;
                background-color: #e6fffa;
                border-radius: 4px;
            }}
            .greeting {{
                font-size: 16px;
                color: #4a5568;
                margin-bottom: 20px;
            }}
            .content {{
                font-size: 15px;
                color: #4a5568;
                margin-bottom: 20px;
            }}
            .btn {{
                display: inline-block;
                padding: 14px 30px;
                background-color: #2b6cb0;
                color: white !important;
                text-decoration: none;
                border-radius: 6px;
                font-weight: 600;
                font-size: 15px;
                margin: 20px 0;
                transition: background-color 0.3s;
            }}
            .btn:hover {{
                background-color: #1a4971;
            }}
            .note {{
                font-size: 14px;
                color: #c53030;
                margin-top: 25px;
                padding: 15px;
                background-color: #fff5f5;
                border-radius: 6px;
                display: flex;
                align-items: center;
                gap: 10px;
            }}
            .footer {{
                font-size: 13px;
                color: #718096;
                text-align: center;
                margin-top: 40px;
                border-top: 1px solid #e6ecf0;
                padding-top: 20px;
            }}
            .icon {{
                font-size: 18px;
            }}
        </style>
    </head>
    <body>
        <div class="email-container">
            <div class="header">Welcome to StreamX</div>

            <div class="greeting">Dear Valued User,</div>

            <div class="content">
                We're delighted to welcome you to <strong>StreamX</strong>, Live Management System. 
                An account has been created for you by the admin team at CHANNEL 1 with the following credentials:
            </div>

            <div class="credentials-box">
                <div class="credential-item">
                    <span class="credential-label">Username:</span>
                    <span>{username}</span>
                </div>
                <div class="credential-item">
                    <span class="credential-label">Email:</span>
                    <span>{email}</span>
                </div>
                <div class="content" style="margin-top: 15px;">
                    You can use either your username or email along with your password to log in.
                </div>
                <div class="password">{temp_password}</div>
            </div>

            <div class="content">
                For your security, please log in using the button below and change your password immediately.
            </div>

            <a href="{settings.FRONTEND_LOGIN_URL}" class="btn">Log In</a>

            <div class="note">
                <span class="icon">🔒</span>
                <div>
                    <strong>Security Notice:</strong> This is a temporary password. 
                    Please update it upon first login to ensure your account remains secure.
                </div>
            </div>

            <div class="footer">
                © {date.today().year} Aranya Tech. All rights reserved.<br/>
                If you did not request this account, please contact our support team immediately.
            </div>
        </div>
    </body>
    </html>
    """

    plain_text = strip_tags(html_content)

    try:
        msg = EmailMessage(
            subject=subject,
            body=html_content,
            from_email=formataddr(("StreamX - Task Manager", "no-reply@aranyait.com.bd")),
            to=[email],
            reply_to=["info@aranyait.com.bd"]
        )

        msg.content_subtype = 'html'  # Set content type to HTML
        msg.send()
        return True, None

    except Exception as e:
        return False, str(e)
    

def send_otp_reset_email(email, username, otp):
    """
    Sends a secure OTP reset email to an existing user.
    Returns (success: bool, error_message: str)
    """
    subject = "StreamX OTP for Password Reset"

    html_content = f"""
    <html>
    <head>
        <style>
            body {{
                font-family: 'Segoe UI', Arial, sans-serif;
                background-color: #f0f4f8;
                margin: 0;
                padding: 0;
                line-height: 1.6;
            }}
            .email-container {{
                max-width: 650px;
                margin: 40px auto;
                background-color: #ffffff;
                border-radius: 12px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
                padding: 40px;
                color: #2d3748;
            }}
            .header {{
                text-align: center;
                font-size: 26px;
                font-weight: 700;
                color: #b83280;
                margin-bottom: 25px;
                border-bottom: 2px solid #fcddec;
                padding-bottom: 15px;
            }}
            .greeting {{
                font-size: 16px;
                color: #4a5568;
                margin-bottom: 20px;
            }}
            .content {{
                font-size: 15px;
                color: #4a5568;
                margin-bottom: 20px;
            }}
            .credentials-box {{
                background-color: #fffaf0;
                border-left: 5px solid #dd6b20;
                padding: 20px;
                margin: 25px 0;
                font-size: 16px;
                color: #7b341e;
                border-radius: 6px;
            }}
            .otp {{
                font-size: 20px;
                font-weight: 600;
                text-align: center;
                background-color: #fefcbf;
                border-radius: 6px;
                padding: 12px;
                margin-top: 15px;
                letter-spacing: 2px;
            }}
            .btn {{
                display: inline-block;
                padding: 14px 30px;
                background-color: #b83280;
                color: white !important;
                text-decoration: none;
                border-radius: 6px;
                font-weight: 600;
                font-size: 15px;
                margin: 20px 0;
                transition: background-color 0.3s;
            }}
            .btn:hover {{
                background-color: #97266d;
            }}
            .note {{
                font-size: 14px;
                color: #c53030;
                margin-top: 25px;
                padding: 15px;
                background-color: #fff5f5;
                border-radius: 6px;
                display: flex;
                align-items: center;
                gap: 10px;
            }}
            .footer {{
                font-size: 13px;
                color: #718096;
                text-align: center;
                margin-top: 40px;
                border-top: 1px solid #e6ecf0;
                padding-top: 20px;
            }}
        </style>
    </head>
    <body>
        <div class="email-container">
            <div class="header">Password Reset Request</div>

            <div class="greeting">Hello {username},</div>

            <div class="content">
                We received a request to reset your password for your <strong>StreamX</strong> account at Channel 1.
                Please use the One-Time Password (OTP) below to proceed:
            </div>

            <div class="credentials-box">
                <div class="otp">{otp}</div>
            </div>

            <div class="content">
                Enter this OTP on the password reset page.
                If you did not request this change, please ignore this email or contact admin immediately.
            </div>


            <div class="note">
                <span>🔒</span>
                <div>
                    <strong>Important:</strong> Do not share this OTP with anyone. Our support team will never ask for your OTP.
                </div>
            </div>

            <div class="footer">
                © {date.today().year} Aranya Tech. All rights reserved.<br/>
                Need help? Contact us at info@aranyait.com.bd
            </div>
        </div>
    </body>
    </html>
    """

    plain_text = strip_tags(html_content)

    try:
        msg = EmailMessage(
            subject=subject,
            body=html_content,
            from_email=formataddr(("StreamX Support", "no-reply@aranyait.com.bd")),
            to=[email],
            reply_to=["info@aranyait.com.bd"]
        )
        msg.content_subtype = 'html'
        msg.send()
        return True, None
    except Exception as e:
        return False, str(e)
    



PYQT5_WS_URL = "ws://127.0.0.1:8765"

def broadcast_recording_event(event_type, payload=None, session_id=None):
    """Broadcast a recording lifecycle event to connected WebSocket clients."""
    try:
        from channels.layers import get_channel_layer
        from asgiref.sync import async_to_sync
        channel_layer = get_channel_layer()
        if channel_layer is None:
            return
        data = {
            'type': event_type,
            'session_id': session_id,
            'timestamp': __import__('django.utils.timezone', fromlist=['now']).now().isoformat(),
            'payload': payload or {},
        }
        async_to_sync(channel_layer.group_send)(
            'recordings',
            {'type': 'recording.event', 'data': data},
        )
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception("Failed to broadcast recording event: %s", e)

def send_command_to_pyqt(command, task_data=None):
    payload = {
        "command": command,
        "task_data": task_data or {},
        "token": getattr(settings, 'TASKQUE_SERVICE_TOKEN', '')
    }

    async def _send():
        try:
            async with websockets.connect(PYQT5_WS_URL) as websocket:
                await websocket.send(json.dumps(payload))
                logger.info("Command sent to PyQt5: %s", payload)
                return True
        except Exception as e:
            logger.exception("Failed sending command to PyQt5: %s", e)
            return False

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # We're inside an async context (ASGI/Channels) — schedule as a
        # fire-and-forget coroutine, don't create a second send via run()
        import concurrent.futures
        future = asyncio.run_coroutine_threadsafe(_send(), loop)
        try:
            return future.result(timeout=5)
        except concurrent.futures.TimeoutError:
            logger.error("Timeout waiting for PyQt5 WebSocket send")
            return False
    else:
        # Purely sync context (WSGI) — safe to create a fresh event loop
        return asyncio.run(_send())