from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from .models import User, Role, Department


# Register the custom User model
@admin.register(User)
class CustomUserAdmin(UserAdmin):
    list_display = ('username', 'email', 'first_name', 'last_name', 'phone_number', 'get_roles', 'is_active','is_new')
    list_filter = ('is_active', 'roles', 'date_joined', 'last_login')
    search_fields = ('username', 'email', 'first_name', 'last_name', 'phone_number')
    ordering = ('-date_joined',)
    filter_horizontal = ('roles', 'user_permissions', 'groups')

    fieldsets = (
        (None, {'fields': ('username', 'password')}),
        ('Personal Info', {'fields': ('first_name', 'last_name', 'email', 'phone_number', 'address', 'profile_picture', 'otp')}),
        ('Permissions', {
            'fields': ('is_active', 'is_staff', 'is_superuser', 'is_new', 'roles', 'user_permissions', 'groups')
        }),
        ('Important Dates', {'fields': ('last_login', 'date_joined')}),
    )

    add_fieldsets = (
        (None, {
            'classes': ('wide',),
            'fields': ('username', 'email', 'password1', 'password2'),
        }),
        ('Personal Info', {'fields': ('first_name', 'last_name', 'phone_number', 'address', 'profile_picture')}),
        ('Permissions', {'fields': ('is_active', 'is_staff', 'is_superuser', 'roles', 'user_permissions', 'groups')}),
    )

    def get_roles(self, obj):
        return ", ".join([role.name for role in obj.roles.all()]) if obj.roles.exists() else "No Roles"
    get_roles.short_description = 'Roles'


# Register the Role model
@admin.register(Role)
class RoleAdmin(admin.ModelAdmin):
    list_display = ('name', 'description_short')
    search_fields = ('name',)
    filter_horizontal = ('permissions',)

    def description_short(self, obj):
        return obj.description[:50] + '...' if len(obj.description) > 50 else obj.description
    description_short.short_description = 'Description'


# Register the Department model
@admin.register(Department)
class DepartmentAdmin(admin.ModelAdmin):
    list_display = ('name', 'head', 'is_active', 'created_at', 'updated_at')
    search_fields = ('name', 'description')
    list_filter = ('is_active', 'head')
    raw_id_fields = ('head',)
    readonly_fields = ('created_at', 'updated_at')

