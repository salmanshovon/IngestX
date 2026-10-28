from .serializers import UserSerializer, PermissionSerializer, UsernameCheckSerializer, UserCreateSerializer, UserDetailSerializer, RoleSerializer, UserDeleteSerializer,  RoleWithCountSerializer
from .serializers import RoleCreateSerializer, RoleDeleteSerializer, RoleUpdateSerializer, UserUpdateSerializer, PasswordChangeSerializer, SendOTPSerializer
from .serializers import RecordPortStatusSerializer, RecordingCRUDSerializer
from accounts.models import User, Role
from rest_framework import generics, status
from rest_framework.permissions import IsAuthenticated, AllowAny
from django.contrib.auth.models import Permission
from django.contrib.auth import authenticate, login, logout
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import BasePermission
from .utils import generate_random_numeric_password, send_welcome_email, send_otp_reset_email, send_command_to_pyqt, broadcast_recording_event
from django.contrib.auth.hashers import make_password
from rest_framework.pagination import PageNumberPagination
from django.db import models
from django.conf import settings
from django.db.models import Q
from django.http import Http404
from records.models import RecordPort, Recording, RecordServer, RecordingSetting
from datetime import datetime, timedelta
from django.utils import timezone
import os
import socket




# Custom Pagination Class
class StandardResultsSetPagination(PageNumberPagination):
    page_size = 10
    page_size_query_param = 'page_size'
    max_page_size = 100

def has_permission(user, permission_name):
    """
    Check if a user has the specified permission.
    
    Args:
        user: The User object to check.
        permission_name: The permission codename (e.g., 'accounts.add_user').
    
    Returns:
        bool: True if the user has the permission, False otherwise.
    """
    if not user or not user.is_authenticated:
        return False
    return user.has_perm(permission_name)

class HasSpecificPermission(BasePermission):
    """
    A generic DRF permission class to check if a user has a specific permission.
    """
    def __init__(self, permission_name):
        self.permission_name = permission_name

    def has_permission(self, request, view):
        return has_permission(request.user, self.permission_name)

class ServiceTokenPermission(BasePermission):
    """Allows access only with a valid X-Service-Token header (TaskQue)."""
    def has_permission(self, request, view):
        token = request.headers.get('X-Service-Token')
        return bool(token) and token == getattr(settings, 'TASKQUE_SERVICE_TOKEN', None)


class IsAuthenticatedOrServiceToken(BasePermission):
    """Allows authenticated users or a valid TaskQue service token (read-only)."""
    def has_permission(self, request, view):
        token = request.headers.get('X-Service-Token')
        if token and token == getattr(settings, 'TASKQUE_SERVICE_TOKEN', None):
            return request.method in ('GET', 'HEAD', 'OPTIONS')
        return bool(request.user and request.user.is_authenticated)


# ---------------------------------------------------------------------------
# Recording lifecycle rules
#
# The browser mirrors these two windows in frontend/src/config.ts
# (`MIN_RECORD_MS` / `DELETE_CUTOFF_MS`); keep the pairs in step. The server is
# the authority: the UI only hides the action, it never owns the decision.
# ---------------------------------------------------------------------------

MIN_RECORDING_DURATION = timedelta(seconds=10)
DELETE_CUTOFF = timedelta(seconds=15)


def recording_delete_block(rec, now=None):
    """
    Why `rec` cannot be deleted right now, as ``(code, message)``, or ``None``.

    Three rules, in the order they matter:

    1. **Recording** -- the engine has the file open. It is stopped, not deleted.
    2. **Past** -- its window has closed. Deleting it would rewrite history.
    3. **Queued** -- within ``DELETE_CUTOFF`` of its start. The item has been
       handed to the recorder and a delete now would race the capture.
    """
    now = now or timezone.now()

    if rec.status == 'RECORDING':
        return (
            'DELETE_BLOCKED',
            'This recording is in progress. Stop it instead of deleting it.',
        )

    if rec.end_time is not None and rec.end_time <= now:
        return (
            'DELETE_BLOCKED',
            'This item has already finished. Past items cannot be deleted.',
        )

    # An open-ended row that has already started is history with no window to
    # reason about -- treat it as past rather than as a recording that can be
    # stopped, because the engine may no longer hold it.
    if rec.end_time is None and rec.start_time <= now:
        return (
            'DELETE_BLOCKED',
            'This item has already started and cannot be deleted.',
        )

    if rec.start_time <= now:
        return (
            'DELETE_BLOCKED',
            'This recording is in progress. Stop it instead of deleting it.',
        )

    if rec.start_time <= now + DELETE_CUTOFF:
        return (
            'DELETE_BLOCKED',
            'This item is queued to start within 15 seconds and can no longer be deleted.',
        )

    return None


def default_recording_duration_minutes():
    setting, _ = RecordingSetting.objects.get_or_create(defaults={'default_duration_minutes': 30})
    try:
        return max(1, int(setting.default_duration_minutes or 30))
    except (TypeError, ValueError):
        return 30


def recording_edit_block(rec, now=None, payload=None):
    """
    Why a scheduled recording may not be moved/edited right now.

    Moving the item or changing its start is frozen by the same 15-second queue
    cutoff as delete: past that point the engine has the item and a retime would
    race the capture. Past and finished items are history.

    End time (duration), file name and operator note stay editable on a queued
    or running capture. They describe the capture rather than when it starts,
    and are exactly what an operator needs to correct while it is recording.
    """
    now = now or timezone.now()

    if rec.status in ('COMPLETED', 'STOPPED', 'FAILED'):
        return (
            'EDIT_BLOCKED',
            'This item has already finished and can no longer be moved, edited or deleted.',
        )

    # End/duration, name and note describe the capture rather than when it
    # starts, so they stay editable while it is queued or already recording.
    # `version` is request metadata added by the scheduler; without allowing it
    # here an end-only PATCH from the timeline looked like a move and was
    # refused as frozen.
    live_editable = {'end_time', 'filename', 'note', 'version'}
    if payload is not None and set(payload).issubset(live_editable):
        return None

    if rec.start_time <= now + DELETE_CUTOFF:
        return (
            'EDIT_BLOCKED',
            'This item is queued or already started (within 15 seconds of its start) and can no longer be moved, edited or deleted.',
        )

    return None


def recording_stop_block(rec, now=None):
    """
    Why `rec` cannot be stopped right now, as ``(code, message)``, or ``None``.

    A file shorter than ten seconds is refused by the engine, so a stop in the
    first ten seconds is rejected here with a readable message instead of
    surfacing the model's validation as a 500.
    """
    now = now or timezone.now()
    if rec.start_time > now:
        return ('NOT_RECORDING', 'This recording has not started yet.')
    if rec.status in ('COMPLETED', 'STOPPED', 'FAILED'):
        return ('NOT_RECORDING', 'This recording is no longer running.')
    earliest = rec.start_time + MIN_RECORDING_DURATION
    if now < earliest:
        remaining = int((earliest - now).total_seconds()) + 1
        return (
            'STOP_TOO_SOON',
            f'A recording must run for at least 10 seconds. Try again in {remaining}s.',
        )
    return None


class UserListView(generics.ListAPIView):
    serializer_class = UserSerializer
    pagination_class = StandardResultsSetPagination

    def get_permissions(self):
        return [HasSpecificPermission('accounts.view_user')]

    def get_queryset(self):
        """
        Returns all users who are not superusers and not cadets, ordered by date joined (newest first).
        Can be filtered by a search query parameter across name, email, and username fields.
        """
        queryset = User.objects.filter(
            is_superuser=False,
            is_cadet=False
        ).order_by('-date_joined')
        
        search_query = self.request.query_params.get('search', None)
        if search_query:
            queryset = queryset.filter(
                models.Q(first_name__icontains=search_query) |
                models.Q(last_name__icontains=search_query) |
                models.Q(email__icontains=search_query) |
                models.Q(username__icontains=search_query)
            )
        
        return queryset

class PermissionListView(generics.ListAPIView):
    queryset = Permission.objects.all()
    serializer_class = PermissionSerializer



class UsernameAvailabilityCheck(APIView):
    serializer_class = UsernameCheckSerializer
    
    def get_permissions(self):
        return [HasSpecificPermission('accounts.add_user')]
    
    def post(self, request):
        print("Raw request data:", request.data)
        serializer = UsernameCheckSerializer(data=request.data)
        if serializer.is_valid():
            # Return proper JSON response with is_available field
            return Response({
                'is_available': True
            })
        # Return error messages in expected format
        return Response({
            'is_available': False,
            'error': next(iter(serializer.errors.values()))[0] if serializer.errors else 'Username is not available.'
        }, status=status.HTTP_200_OK)  # Return 200 status so frontend can process the error


class UserCreateView(APIView):
    def get_permissions(self):
        return [HasSpecificPermission('accounts.add_user')]

    def post(self, request):
        print(request.data)
        serializer = UserCreateSerializer(data=request.data)
        
        if serializer.is_valid():
            # Create user without password first
            user = serializer.save()
            
            # Generate and set password
            temp_password = generate_random_numeric_password()
            user.password = make_password(temp_password)
            user.save()
            
            send_welcome_email(user.email, user.username, temp_password)
            
            return Response(
                {
                    'message': 'User created successfully',
                    'username': user.username,
                    'email': user.email
                    # Don't return password in response
                },
                status=status.HTTP_201_CREATED
            )
        print(serializer.errors)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    

class UserUpdateView(APIView):
    def get_permissions(self):
        return [HasSpecificPermission('accounts.change_user')]

    def get_object(self, pk):
        try:
            return User.objects.get(pk=pk)
        except User.DoesNotExist:
            raise Http404

    def patch(self, request, pk):
        user = self.get_object(pk)
        serializer = UserUpdateSerializer(user, data=request.data, partial=True)

        if serializer.is_valid():
            updated_user = serializer.save()

            return Response(
                {
                    'message': 'User updated successfully',
                    'user_id': updated_user.id,
                    'updated_fields': list(serializer.validated_data.keys()),
                    'email': updated_user.email
                },
                status=status.HTTP_200_OK
            )

        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class UserDetailView(generics.RetrieveAPIView):
    queryset = User.objects.all()
    serializer_class = UserDetailSerializer
    lookup_field = 'id'

    def get_permissions(self):
        return [HasSpecificPermission('accounts.change_user')]

    def retrieve(self, request, *args, **kwargs):
        instance = self.get_object()
        user_serializer = self.get_serializer(instance)

        all_roles = Role.objects.all()
        role_serializer = RoleSerializer(all_roles, many=True)

        return Response({
            'user': user_serializer.data,
            'roles': role_serializer.data
        })



class UserDeleteView(generics.DestroyAPIView):
    queryset = User.objects.all()
    serializer_class = UserDeleteSerializer
    lookup_field = 'id'

    def get_permissions(self):
        return [HasSpecificPermission('accounts.delete_user')]

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        
        # Create serializer with the instance and context
        serializer = self.get_serializer(instance, data={}, context={'request': request})
        serializer.is_valid(raise_exception=True)  # Now this will work
        
        self.perform_destroy(instance)
        return Response(
            {"message": "User account deleted successfully!"},
            status=status.HTTP_204_NO_CONTENT
        )

class UserDeactivateView(generics.UpdateAPIView):
    queryset = User.objects.all()
    serializer_class = None  # No serializer needed for simple status change
    lookup_field = 'id'
    http_method_names = ['patch']  # Only allow PATCH method

    def get_permissions(self):
        return [HasSpecificPermission('accounts.change_user')]

    def update(self, request, *args, **kwargs):
        user = self.get_object()
        
        # Prevent deactivation of superusers
        if user.is_superuser:
            return Response(
                {"detail": "Superusers cannot be deactivated."},
                status=status.HTTP_403_FORBIDDEN
            )
        
        # Prevent self-deactivation
        if user == request.user:
            return Response(
                {"detail": "You cannot deactivate your own account."},
                status=status.HTTP_403_FORBIDDEN
            )
        
        user.is_active = False
        user.save()
        return Response(
            {"detail": "User deactivated successfully."},
            status=status.HTTP_200_OK
        )
    

class UserActivateView(generics.UpdateAPIView):
    queryset = User.objects.all()
    serializer_class = None  # No serializer needed for simple status change
    lookup_field = 'id'
    http_method_names = ['patch']  # Only allow PATCH method

    def get_permissions(self):
        return [HasSpecificPermission('accounts.change_user')]

    def update(self, request, *args, **kwargs):
        user = self.get_object()
        
        user.is_active = True
        user.save()
        return Response(
            {"detail": "User activated successfully."},
            status=status.HTTP_200_OK
        )
    
class RolePermissionsView(generics.RetrieveAPIView):
    """
    Returns both roles with counts and filtered permissions (excluding EXCLUDED_PERMS)
    """
    def get_permissions(self):
        return [HasSpecificPermission('accounts.view_role')]

    def get(self, request, *args, **kwargs):
        roles = Role.objects.prefetch_related('permissions', 'users').all()
        permissions = Permission.objects.all()

        # Filter out excluded permissions
        if hasattr(settings, 'EXCLUDED_PERMS') and settings.EXCLUDED_PERMS:
            exclusion_query = Q()
            for perm_pattern in settings.EXCLUDED_PERMS:
                if '.' in perm_pattern:
                    app_label, codename_pattern = perm_pattern.split('.')
                    
                    if codename_pattern == '*':  # Exclude all permissions for app
                        exclusion_query |= Q(
                            content_type__app_label=app_label
                        )
                    elif '*' in codename_pattern:  # Wildcard match
                        base = codename_pattern.replace('*', '')
                        exclusion_query |= Q(
                            content_type__app_label=app_label,
                            codename__contains=base
                        )
                    else:  # Exact match
                        exclusion_query |= Q(
                            content_type__app_label=app_label,
                            codename=codename_pattern
                        )
            
            if exclusion_query:
                permissions = permissions.exclude(exclusion_query)

        role_serializer = RoleWithCountSerializer(roles, many=True)
        permission_serializer = PermissionSerializer(permissions, many=True)
        
        return Response({
            'roles': role_serializer.data,
            'permissions': permission_serializer.data
        })


class RoleCreateView(generics.CreateAPIView):
    queryset = Role.objects.all()
    serializer_class = RoleCreateSerializer

    def get_permissions(self):
        return [HasSpecificPermission('accounts.add_role')]
    
    def perform_create(self, serializer):
        """Simply save the instance - serializer handles creation logic"""
        serializer.save()

    def create(self, request, *args, **kwargs):
        """Enhanced response format"""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        
        role = serializer.instance
        headers = self.get_success_headers(serializer.data)
        
        return Response(
            {
                'status': 'success',
                'role': {
                    'id': role.id,
                    'name': role.name,
                    'description': role.description,
                    'permissions_count': role.permissions.count()
                },
                'message': f'Role "{role.name}" created successfully'
            },
            status=status.HTTP_201_CREATED,
            headers=headers
        )
    
class RoleDeleteView(generics.DestroyAPIView):
    queryset = Role.objects.all()
    serializer_class = RoleDeleteSerializer
    lookup_field = 'id'

    def get_permissions(self):
        return [HasSpecificPermission('accounts.delete_role')]

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        
        # Create serializer with the instance and context
        serializer = self.get_serializer(instance, data={}, context={'request': request})
        serializer.is_valid(raise_exception=True)  # This will run the validate() method
        
        self.perform_destroy(instance)
        return Response(
            {"message": "Role deleted successfully!"},
            status=status.HTTP_204_NO_CONTENT
        )
    
class RoleUpdateView(generics.UpdateAPIView):
    queryset = Role.objects.all()
    serializer_class = RoleUpdateSerializer
    lookup_field = 'id'

    def get_permissions(self):
        return [HasSpecificPermission('accounts.change_role')]
    
    def perform_update(self, serializer):
        """Save the instance - serializer handles update logic"""
        serializer.save()

    def update(self, request, *args, **kwargs):
        """Enhanced response format with proper error handling"""
        partial = kwargs.pop('partial', False)
        
        try:
            instance = self.get_object()
            serializer = self.get_serializer(instance, data=request.data, partial=partial)
            
            if not serializer.is_valid():
                return Response(
                    {
                        'status': 'error',
                        'errors': serializer.errors,
                        'message': 'Validation failed'
                    },
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            self.perform_update(serializer)
            
            # Get updated instance after save
            role = serializer.instance
            
            return Response(
                {
                    'status': 'success',
                    'role': {
                        'id': role.id,
                        'name': role.name,
                        'description': role.description,
                        'permissions_count': role.permissions.count()
                    },
                    'message': f'Role "{role.name}" updated successfully'
                },
                status=status.HTTP_200_OK
            )
        except serializer.ValidationError as e:
            return Response(
                {
                    'status': 'error',
                    'errors': e.detail,
                    'message': 'Validation error'
                },
                status=status.HTTP_400_BAD_REQUEST
            )
        except Exception as e:
            return Response(
                {
                    'status': 'error',
                    'message': f'Error updating role: {str(e)}'
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
        

class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]
    def post(self, request, *args, **kwargs):
        serializer = PasswordChangeSerializer(data=request.data, context={'request': request})
        if serializer.is_valid():
            serializer.save()
            return Response({"detail": "Password updated successfully."}, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    

class IsUnauthenticated(BasePermission):
    """
    Only allows access to users who are NOT authenticated.
    """
    def has_permission(self, request, view):
        return not request.user.is_authenticated  # Allow only if user is NOT authenticated

class SendOTPView(APIView):
    permission_classes = [IsUnauthenticated]  # Apply custom permission
    serializer_class = SendOTPSerializer

    def post(self, request, *args, **kwargs):
        serializer = self.serializer_class(data=request.data)
        if serializer.is_valid():
            email = serializer.validated_data['email']
            try:
                user = User.objects.get(email=email)
                otp = generate_random_numeric_password()
                user.otp = otp  # Assuming 'otp' is a field in your User model
                user.save()

                success, error_message = send_otp_reset_email(user.email, user.username, otp)
                if success:
                    return Response({'message': 'OTP sent successfully to your email.'}, status=status.HTTP_200_OK)
                else:
                    return Response({'error': f'Failed to send OTP email. Please try again. {error_message}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

            except User.DoesNotExist:
                return Response({'error': 'No account found with this email address.'}, status=status.HTTP_404_NOT_FOUND)
            except Exception as e:
                return Response({'error': f'Failed to send OTP. Please try again. {str(e)}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

class VerifyOTPView(APIView):
    permission_classes = [IsUnauthenticated]  # Apply custom permission

    def post(self, request, *args, **kwargs):
        email = request.data.get('email')
        otp = request.data.get('otp')

        if not email or not otp:
            return Response({'error': 'Email and OTP are required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            user = User.objects.get(email=email)
            if user.otp == int(otp) and otp != '':
                resp = generate_random_numeric_password()
                user.otp = resp
                user.save()
                return Response({'message': 'OTP verified successfully.', 'tesseract': resp}, status=status.HTTP_200_OK)
            else:
                return Response({'error': 'Invalid OTP.'}, status=status.HTTP_400_BAD_REQUEST)

        except User.DoesNotExist:
            return Response({'error': 'No account found with this email address.'}, status=status.HTTP_404_NOT_FOUND)
        except Exception as e:
            return Response({'error': f'Failed to verify OTP. Please try again. {str(e)}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)



class PasswordChangeTesseract(APIView):
    permission_classes = [IsUnauthenticated]

    def post(self, request, *args, **kwargs):
        email = request.data.get('email')
        tess = request.data.get('tess')
        new_password = request.data.get('new_pass')
        confirm_password = request.data.get('confirm_pass')

        if not email or not tess or not new_password or not confirm_password:
            return Response({'error': 'Invalid data.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            user = User.objects.get(email=email)
            if user.otp == int(tess) and tess and new_password == confirm_password:
                user.otp = None
                user.password = make_password(new_password)
                user.save()
                return Response({'message': 'Password Changed successful.'}, status=status.HTTP_200_OK)
            else:
                return Response({'error': 'Invalid data.'}, status=status.HTTP_400_BAD_REQUEST)

        except User.DoesNotExist:
            return Response({'error': 'Invalid data.'}, status=status.HTTP_400_BAD_REQUEST)
        except Exception:
            return Response({'error': 'Invalid data.'}, status=status.HTTP_400_BAD_REQUEST)





import socket

class StartRecordView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = RecordingCRUDSerializer(data=request.data)

        if serializer.is_valid():

            data = serializer.validated_data
            start = data.get('start_time') or timezone.now()
            if timezone.is_naive(start):
                start = timezone.make_aware(start)
            end = data.get('end_time')
            if end is None:
                end = start + timedelta(minutes=default_recording_duration_minutes())
            if timezone.is_naive(end):
                end = timezone.make_aware(end)

            ser = serializer.save(start_time=start, end_time=end)
            recording = request.data

            task_data = {
                "id": ser.id,
                "filename": ser.filename,
                "start_time": ser.start_time.isoformat(),
                "end_time": ser.end_time.isoformat(),
                "port": recording["port"],
            }

            sent = send_command_to_pyqt(
                command="start_now",
                task_data=task_data
            )

            if sent:
                broadcast_recording_event('recording.started', {'recording': task_data}, session_id=task_data.get('id'))
                return Response(
                    {
                        "message": "Recording start command sent to PyQt5",
                        "task_data": task_data
                    },
                    status=status.HTTP_200_OK
                )

            return Response(
                {
                    "error": "Could not connect to PyQt5 WebSocket server",
                    "task_data": task_data
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE
            )

        return Response(
            serializer.errors,
            status=status.HTTP_400_BAD_REQUEST
        )
    



class StopRecordView(APIView):
    permission_classes = [IsAuthenticated]
    def post(self, request):
        print("Request data:", request.data)
        
        # Get the recording ID
        recording_id = request.data.get('id')
        
        if not recording_id:
            return Response(
                {"error": "Recording ID is required to stop a recording"},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            # Get the existing recording instance
            recording_instance = Recording.objects.get(id=recording_id)
        except Recording.DoesNotExist:
            return Response(
                {"error": f"Recording with id {recording_id} not found"},
                status=status.HTTP_404_NOT_FOUND
            )

        # Refuse a stop that would produce an illegal (<10s) file. The engine's
        # model validation would otherwise raise a 500 from save().
        block = recording_stop_block(recording_instance)
        if block:
            code, message = block
            return Response(
                {'detail': message, 'code': code},
                status=status.HTTP_409_CONFLICT,
            )

        requested_end = request.data.get('end_time')
        end_time = timezone.now()
        if requested_end:
            try:
                end_time = datetime.fromisoformat(str(requested_end).replace('Z', '+00:00'))
            except (TypeError, ValueError):
                return Response(
                    {'detail': 'end_time is not a valid ISO-8601 timestamp.', 'code': 'INVALID'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if timezone.is_naive(end_time):
                end_time = timezone.make_aware(end_time, timezone.get_current_timezone())

        # Trust the server clock over the browser's: a skewed client must not
        # write an end time in the past (the database row would claim a
        # recording finished before it actually did).
        server_now = timezone.now()
        if end_time < server_now:
            end_time = server_now

        # The operator asked to stop now; never let the recorded end precede
        # the minimum duration the engine will accept.
        earliest_end = recording_instance.start_time + MIN_RECORDING_DURATION
        if end_time < earliest_end:
            end_time = earliest_end

        # Update the recording status
        recording_instance.status = 'STOPPED'
        recording_instance.end_time = end_time
        recording_instance.save()

        
        task_data = {
            "id": recording_instance.id,
            "filename": recording_instance.filename,
            "port" : recording_instance.port.channel_index,
        }

        sent = send_command_to_pyqt(
            command="stop_now",
            task_data=task_data
        )


        if sent:
            broadcast_recording_event('recording.stopping', {'id': recording_instance.id, 'filename': recording_instance.filename}, session_id=recording_instance.id)
            return Response(
                {
                    "message": "Recording stop command sent to PyQt5",
                    "id": recording_instance.id,
                    "filename": recording_instance.filename,
                    "task_data": task_data
                },
                status=status.HTTP_200_OK
            )

        return Response(
            {
                "error": "Could not connect to PyQt5 WebSocket server",
                "task_data": task_data
            },
            status=status.HTTP_503_SERVICE_UNAVAILABLE
        )



class RecordPortStatusView(generics.ListAPIView):
    """
    An API view that returns a list of all record ports and their status.
    Supports standard .as_view() calling convention.
    """
    permission_classes = [IsAuthenticated]
    queryset = RecordPort.objects.all().select_related('server')
    serializer_class = RecordPortStatusSerializer

    def get_queryset(self):
        queryset = super().get_queryset()
        # Keeps your optional 'available' query parameter filtering intact!
        only_available = self.request.query_params.get('available', 'false').lower() == 'true'
        
        if only_available:
            return queryset.filter(is_recording=False, server__is_active=True)
        return queryset
    

class RecordingListCreateView(generics.ListCreateAPIView):
    """
    Handles List (GET) and Create (POST) operations for Recordings.
    """
    queryset = Recording.objects.all()
    serializer_class = RecordingCRUDSerializer
    permission_classes = [IsAuthenticatedOrServiceToken]

    def get_queryset(self):
        today = timezone.now().date()
        yesterday = today - timedelta(days=1)
        tomorrow = today + timedelta(days=1)
        
        return Recording.objects.filter(
            start_time__date__in=[yesterday, today, tomorrow]
        ).order_by('start_time')

    def perform_create(self, serializer):
        start = serializer.validated_data.get('start_time') or timezone.now()
        if timezone.is_naive(start):
            start = timezone.make_aware(start)
        end = serializer.validated_data.get('end_time')
        if end is None:
            end = start + timedelta(minutes=default_recording_duration_minutes())
        if timezone.is_naive(end):
            end = timezone.make_aware(end)

        # 1. Save the new recording instance to the database
        instance = serializer.save(start_time=start, end_time=end)
        
        # 2. Trigger your utility to alert PyQt5
        send_command_to_pyqt(
            command="CREATE",
            task_data=serializer.data
        )
        broadcast_recording_event('recording.created', {'recording': serializer.data}, session_id=instance.id)

    def dispatch(self, request, *args, **kwargs):
        return super().dispatch(request, *args, **kwargs)


class RecordingDetailView(generics.RetrieveUpdateDestroyAPIView):
    """
    Handles Retrieve (GET), Update (PUT/PATCH), and Delete (DELETE) operations 
    for a single Recording instance by its ID.
    """
    queryset = Recording.objects.all()
    serializer_class = RecordingCRUDSerializer
    permission_classes = [IsAuthenticated]

    def destroy(self, request, *args, **kwargs):
        """Apply the same delete window as the scheduler endpoints."""
        instance = self.get_object()
        block = recording_delete_block(instance)
        if block:
            code, message = block
            return Response(
                {'detail': message, 'code': code},
                status=status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        block = recording_edit_block(instance, payload=request.data or {})
        if block:
            code, message = block
            return Response(
                {'detail': message, 'code': code},
                status=status.HTTP_409_CONFLICT,
            )
        return super().update(request, *args, **kwargs)

    def perform_update(self, serializer):
        # 1. Save changes (via either PUT or PATCH)
        instance = serializer.save()
        print("Got Patch Request:")
        print(instance)

        # 2. Alert PyQt5 about the updated attributes
        send_command_to_pyqt(
            command="UPDATE",
            task_data=serializer.data
        )
        broadcast_recording_event('recording.updated', {'recording': serializer.data}, session_id=instance.id)

    def perform_destroy(self, instance):
        # Capture critical details before removing the record from the DB
        task_id = instance.id
        task_filename = instance.filename
        
        # 1. Delete from database
        instance.delete()
        
        # 2. Alert PyQt5 so it can clean up its UI list view
        send_command_to_pyqt(
            command="DELETE",
            task_data={
                "id": task_id,
                "filename": task_filename
            }
        )



class ScheduleDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def _get(self, pk):
        try:
            return Recording.objects.select_related('port').get(id=pk)
        except Recording.DoesNotExist:
            return None

    def get(self, request, pk):
        rec = self._get(pk)
        if rec is None:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(recording_to_event(rec))

    def patch(self, request, pk):
        rec = self._get(pk)
        if rec is None:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        data = request.data or {}
        block = recording_edit_block(rec, payload=data)
        if block:
            code, message = block
            return Response(
                {'detail': message, 'code': code},
                status=status.HTTP_409_CONFLICT,
            )
        if 'scheduled_time' in data or 'start_time' in data:
            rec.start_time = data.get('scheduled_time', data.get('start_time', rec.start_time))
        if 'end_time' in data:
            rec.end_time = data.get('end_time')
        if 'filename' in data:
            rec.filename = data.get('filename', rec.filename)
        if 'filepath' in data:
            rec.filepath = data.get('filepath', rec.filepath)
        if 'status' in data:
            rec.status = data.get('status', rec.status)
        if 'note' in data:
            rec.note = data.get('note', rec.note)
        try:
            rec.save()
        except Exception as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        # Keep the TaskQue desktop engine in sync with schedule edits (end time,
        # file name, ...) so an in-flight capture is re-timed / renamed on the
        # fly. Mirrors RecordingDetailView.perform_update.
        task_data = {
            "id": rec.id,
            "filename": rec.filename,
            "start_time": rec.start_time.isoformat() if rec.start_time else None,
            "end_time": rec.end_time.isoformat() if rec.end_time else None,
            "port": rec.port_id,
        }
        send_command_to_pyqt(command="UPDATE", task_data=task_data)
        try:
            broadcast_recording_event('recording.updated', {'recording': task_data}, session_id=rec.id)
        except Exception:
            pass

        return Response(recording_to_event(rec))

    def put(self, request, pk):
        return self.patch(request, pk)

    def delete(self, request, pk):
        rec = self._get(pk)
        if rec is None:
            return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
        block = recording_delete_block(rec)
        if block:
            code, message = block
            return Response(
                {'detail': message, 'code': code},
                status=status.HTTP_409_CONFLICT,
            )
        task_id = rec.id
        task_filename = rec.filename
        rec.delete()
        # Keep the TaskQue desktop engine in sync.
        send_command_to_pyqt(
            command="DELETE",
            task_data={"id": task_id, "filename": task_filename},
        )
        try:
            broadcast_recording_event('recording.deleted', {'id': task_id}, session_id=task_id)
        except Exception:
            pass
        return Response({'deleted': [task_id], 'failed': []}, status=status.HTTP_200_OK)

class ScheduleBulkDeleteView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request):
        ids = request.data.get('ids') if isinstance(request.data, dict) else None
        if not isinstance(ids, list):
            ids = []
        deleted = []
        failed = []
        # One clock read for the whole batch: every id is judged at the same
        # instant, and a slow loop cannot let an item cross the cutoff midway.
        now = timezone.now()
        for pk in ids:
            try:
                pk = int(pk)
            except (TypeError, ValueError):
                failed.append({'id': pk, 'error': 'Invalid id.', 'code': 'INVALID'})
                continue
            try:
                rec = Recording.objects.get(id=pk)
            except Recording.DoesNotExist:
                failed.append({'id': pk, 'error': 'Not found.', 'code': 'NOT_FOUND'})
                continue
            block = recording_delete_block(rec, now=now)
            if block:
                code, message = block
                failed.append({'id': pk, 'error': message, 'code': code})
                continue
            task_id = rec.id
            task_filename = rec.filename
            rec.delete()
            # Keep the TaskQue desktop engine in sync.
            send_command_to_pyqt(
                command="DELETE",
                task_data={"id": task_id, "filename": task_filename},
            )
            deleted.append(task_id)
        return Response({'deleted': deleted, 'failed': failed}, status=status.HTTP_200_OK)


class LoginView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        username_or_email = request.data.get('username') or request.data.get('email') or request.data.get('identifier')
        password = request.data.get('password')
        if not username_or_email or not password:
            return Response({'detail': 'Username/email and password are required.'}, status=status.HTTP_400_BAD_REQUEST)

        username = username_or_email
        if '@' in username_or_email:
            try:
                username = User.objects.get(email=username_or_email).username
            except User.DoesNotExist:
                username = username_or_email

        user = authenticate(request, username=username, password=password)
        if user is None:
            return Response({'detail': 'Invalid credentials.'}, status=status.HTTP_401_UNAUTHORIZED)

        login(request, user)
        return Response({
            'user': {
                'id': user.id,
                'username': user.username,
                'email': user.email,
                'first_name': user.first_name,
                'last_name': user.last_name,
                'department': None,
                'is_new': user.is_new,
                'is_superuser': user.is_superuser,
            },
            'roles': [{'id': r.id, 'name': r.name} for r in user.roles.all()],
            'permissions': ['*'] if user.is_superuser else list(user.get_all_permissions()),
            'is_new': user.is_new,
        }, status=status.HTTP_200_OK)


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        logout(request)
        return Response({'detail': 'Logged out.'}, status=status.HTTP_200_OK)


class CurrentUserView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        return Response({
            'user': {
                'id': user.id,
                'username': user.username,
                'email': user.email,
                'first_name': user.first_name,
                'last_name': user.last_name,
                'department': None,
                'is_new': user.is_new,
                'is_superuser': user.is_superuser,
            },
            'roles': [{'id': r.id, 'name': r.name} for r in user.roles.all()],
            'permissions': ['*'] if user.is_superuser else list(user.get_all_permissions()),
            'is_new': user.is_new,
        }, status=status.HTTP_200_OK)


class PlayoutChannelListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        channels = []
        for port in RecordPort.objects.select_related('server').all():
            channels.append({
                'id': port.id,
                'server': port.server.id,
                'server_name': port.server.name,
                'name': port.name,
                'primary_channel_number': port.channel_index,
                'primary_playout_layer': 1,
                'primary_graphics_layer': 1,
                'secondary_channel_number': 0,
                'secondary_receiver_layer': 0,
                'stream_source_url': '',
                'output_destination_url': '',
                'preview_stream_url': '',
                'preview_embed_url': '',
                'is_on_air': port.is_recording,
                'secondary_route_ref': '',
                'engine_state': 'online' if port.server.is_active else 'offline',
                'created_at': __import__('django.utils.timezone', fromlist=['now']).now().isoformat(),
                'updated_at': __import__('django.utils.timezone', fromlist=['now']).now().isoformat(),
            })
        return Response(channels)


class ServerListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        now = __import__('django.utils.timezone', fromlist=['now']).now().isoformat()
        out = []
        for server in RecordServer.objects.all():
            out.append({
                'id': server.id,
                'name': server.name,
                'ip_address': server.ip_address,
                'amcp_port': 0,
                'is_active': server.is_active,
                'engine_heartbeat_at': None,
                'engine_version': '',
                'agent_state': 'online' if server.is_active else 'offline',
                'pipeline_count': server.ports.count(),
                'created_at': now,
                'updated_at': now,
            })
        return Response(out)


class MediaItemListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response([])


class RecordSettingView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        setting, _ = RecordingSetting.objects.get_or_create(defaults={'default_duration_minutes': 30})
        return Response({'default_duration_minutes': setting.default_duration_minutes})

    def patch(self, request):
        setting, _ = RecordingSetting.objects.get_or_create(defaults={'default_duration_minutes': 30})
        minutes = request.data.get('default_duration_minutes')
        if minutes is not None:
            setting.default_duration_minutes = int(minutes)
            setting.save()
        return Response({'default_duration_minutes': setting.default_duration_minutes})



def recording_to_event(rec):
    STATUS_MAP = {
        'SCHEDULED': 'PENDING',
        'RECORDING': 'PLAYING',
        'COMPLETED': 'COMPLETED',
        'FAILED': 'FAILED',
        'STOPPED': 'COMPLETED',
    }
    start = rec.start_time
    end = rec.end_time
    duration_seconds = ''
    if start and end:
        duration_seconds = str((end - start).total_seconds())
    return {
        'id': rec.id,
        'pipeline': rec.port_id,
        'action_type': 'RECORD',
        'media_item': None,
        'media_lane': 'FILE',
        'media_title': rec.filename,
        'media_type': 'FILE',
        'media_file_path': rec.filepath or '',
        'template_name': None,
        'scheduled_time': start.isoformat() if start else None,
        'end_time': end.isoformat() if end else None,
        'effective_end_time': end.isoformat() if end else None,
        'duration_seconds': duration_seconds,
        'status': STATUS_MAP.get(rec.status, 'PENDING'),
        'hold_seconds': None,
        'version': 1,
        'note': getattr(rec, 'note', '') or '',
        'is_locked': False,
        'is_on_air': rec.status == 'RECORDING',
        'is_held': False,
        'created_by': None,
        'updated_by': None,
        'created_at': (rec.start_time or timezone.now()).isoformat(),
        'updated_at': (rec.start_time or timezone.now()).isoformat(),
    }

STATUS_MAP = {
    'SCHEDULED': 'PENDING',
    'RECORDING': 'PLAYING',
    'COMPLETED': 'COMPLETED',
    'FAILED': 'FAILED',
    'STOPPED': 'COMPLETED',
}

class ScheduleListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        pipeline_id = request.query_params.get('pipeline_id')
        recordings = Recording.objects.select_related('port').all()
        if pipeline_id:
            try:
                recordings = recordings.filter(port_id=int(pipeline_id))
            except (TypeError, ValueError):
                pass

        # Optional date filtering (best-effort, mirrors the schedule query).
        from_param = request.query_params.get('from')
        to_param = request.query_params.get('to')
        if from_param or to_param:
            if from_param:
                try:
                    recordings = recordings.filter(start_time__gte=from_param)
                except Exception:
                    pass
            if to_param:
                try:
                    recordings = recordings.filter(start_time__lte=to_param)
                except Exception:
                    pass
        else:
            # Default to the same recent window the recordings endpoint uses,
            # so the schedule does not pull the entire history on every load.
            today = timezone.now().date()
            yesterday = today - timedelta(days=1)
            tomorrow = today + timedelta(days=1)
            recordings = recordings.filter(start_time__date__in=[yesterday, today, tomorrow])

        results = []
        for rec in recordings.order_by('start_time'):
            start = rec.start_time
            end = rec.end_time
            duration_seconds = ''
            if start and end:
                duration_seconds = str((end - start).total_seconds())
            results.append({
                'id': rec.id,
                'pipeline': rec.port_id,
                'action_type': 'RECORD',
                'media_item': None,
                'media_lane': 'FILE',
                'media_title': rec.filename,
                'media_type': 'FILE',
                'media_file_path': rec.filepath or '',
                'template_name': None,
                'scheduled_time': start.isoformat() if start else None,
                'end_time': end.isoformat() if end else None,
                'effective_end_time': end.isoformat() if end else None,
                'duration_seconds': duration_seconds,
                'status': STATUS_MAP.get(rec.status, 'PENDING'),
                'hold_seconds': None,
                'version': 1,
                'note': getattr(rec, 'note', '') or '',
                'is_locked': False,
                'is_on_air': rec.status == 'RECORDING',
                'is_held': False,
                'created_by': None,
                'updated_by': None,
                'created_at': (rec.start_time or timezone.now()).isoformat(),
                'updated_at': (rec.start_time or timezone.now()).isoformat(),
            })

        return Response({
            'count': len(results),
            'offset': 0,
            'limit': len(results),
            'results': results,
        })

    def post(self, request):
        data = request.data or {}
        port_id = data.get('port', data.get('pipeline'))
        try:
            rec = Recording(
                port_id=port_id,
                filename=data.get('filename', ''),
                filepath=data.get('filepath', ''),
                start_time=data.get('start_time', data.get('scheduled_time', timezone.now())),
                end_time=data.get('end_time'),
                status=data.get('status', 'SCHEDULED'),
            )
            rec.save()
        except Exception as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(recording_to_event(rec), status=status.HTTP_201_CREATED)



class RecordingDetailViewToo(generics.RetrieveUpdateDestroyAPIView):
    """
    Handles Retrieve (GET), Update (PUT/PATCH), and Delete (DELETE) operations 
    for a single Recording instance by its ID.
    Requires user authentication.
    """
    queryset = Recording.objects.all()
    serializer_class = RecordingCRUDSerializer
    permission_classes = [ServiceTokenPermission]

    def perform_update(self, serializer):
        instance = serializer.save()
        # Broadcast status transitions coming from TaskQue (record_cron)
        status_val = (serializer.data.get('status') or instance.status).lower()
        event_type = 'recording.progress'
        if instance.status == 'RECORDING':
            event_type = 'recording.started'
        elif instance.status in ('COMPLETED', 'STOPPED'):
            event_type = 'recording.completed'
        elif instance.status == 'FAILED':
            event_type = 'recording.error'
        broadcast_recording_event(event_type, {'recording': serializer.data}, session_id=instance.id)




