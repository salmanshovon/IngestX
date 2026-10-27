from django.urls import path
from .views import (
    UserListView, PermissionListView, UsernameAvailabilityCheck, UserCreateView,
    UserDetailView, UserDeleteView, UserDeactivateView, UserActivateView,
    RolePermissionsView, RoleCreateView, RoleDeleteView, RoleUpdateView,
    UserUpdateView, ChangePasswordView, SendOTPView, VerifyOTPView,
    PasswordChangeTesseract, RecordPortStatusView, RecordingListCreateView,
    RecordingDetailView, RecordingDetailViewToo, StartRecordView, StopRecordView,
    LoginView, LogoutView, CurrentUserView,
    PlayoutChannelListView, ScheduleListView, ScheduleDetailView, ScheduleBulkDeleteView,
    ServerListView, MediaItemListView,
    RecordSettingView,
)

urlpatterns = [
    # Auth
    path('auth/login/', LoginView.as_view(), name='auth-login'),
    path('auth/logout/', LogoutView.as_view(), name='auth-logout'),
    path('auth/me/', CurrentUserView.as_view(), name='auth-me'),

    # Compatibility endpoints for the PlyOut-style frontend
    path('playout-channels/', PlayoutChannelListView.as_view(), name='playout-channels'),
    path('schedules/', ScheduleListView.as_view(), name='schedules'),
    path('schedules/bulk/', ScheduleBulkDeleteView.as_view(), name='schedule-bulk-delete'),
    path('schedules/<int:pk>/', ScheduleDetailView.as_view(), name='schedule-detail'),
    path('servers/', ServerListView.as_view(), name='servers'),
    path('media-items/', MediaItemListView.as_view(), name='media-items'),
    path('record-settings/', RecordSettingView.as_view(), name='record-settings'),

    # Users
    path('userlist/', UserListView.as_view(), name='user_list'),
    path('permissions/', PermissionListView.as_view(), name='permissions'),
    path('pass_change/', ChangePasswordView.as_view(), name='pass-change'),
    path('pass_change_tess/', PasswordChangeTesseract.as_view(), name='pass-change-tess'),
    path('send_otp/', SendOTPView.as_view(), name='otp-send'),
    path('verify_otp/', VerifyOTPView.as_view(), name='verify-otp'),
    path('check_user/', UsernameAvailabilityCheck.as_view(), name='check_username'),
    path('create_user/', UserCreateView.as_view(), name='user_create'),
    path('user_details/<int:id>/', UserDetailView.as_view(), name='user-details'),
    path('user_update/<int:pk>/', UserUpdateView.as_view(), name='user-update'),
    path('user_delete/<int:id>/', UserDeleteView.as_view(), name='user-delete'),
    path('user_deactivate/<int:id>/', UserDeactivateView.as_view(), name='user-deactivate'),
    path('user_activate/<int:id>/', UserActivateView.as_view(), name='user-activate'),

    # Roles
    path('role_permissions/', RolePermissionsView.as_view(), name='role-perms'),
    path('role_create/', RoleCreateView.as_view(), name='role-create'),
    path('role_delete/<int:id>/', RoleDeleteView.as_view(), name='role-delete'),
    path('role_update/<int:id>/', RoleUpdateView.as_view(), name='role-update'),

    # Recording
    path('start_record/', StartRecordView.as_view(), name='start-record'),
    path('stop_record/', StopRecordView.as_view(), name='stop-record'),
    path('record_ports/', RecordPortStatusView.as_view(), name='record-ports'),
    path('recordings/', RecordingListCreateView.as_view(), name='recording-list-create'),
    path('recordings/<int:pk>/', RecordingDetailView.as_view(), name='recording-detail'),
    path('record_cron/<int:pk>/', RecordingDetailViewToo.as_view(), name='recording-detail-cron'),
]
