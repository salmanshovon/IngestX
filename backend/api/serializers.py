from rest_framework import serializers
from accounts.models import User, Role
from django.contrib.auth.models import Permission
from django.core.validators import RegexValidator
from records.models import RecordServer, RecordPort, Recording
import json
import os
import uuid
from django.contrib.auth.hashers import make_password


class PermissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Permission
        fields = ['id', 'name', 'codename', 'content_type']

class RoleSerializer(serializers.ModelSerializer):
    class Meta:
        model = Role
        fields = ['id', 'name']


class RoleWithCountSerializer(serializers.ModelSerializer):
    user_count = serializers.SerializerMethodField()
    permissions = PermissionSerializer(many=True, read_only=True)
    
    class Meta:
        model = Role
        fields = ['id', 'name', 'description', 'user_count', 'permissions']
    
    def get_user_count(self, obj):
        return obj.users.count()

# User Serializer
class UserSerializer(serializers.ModelSerializer):
    roles = RoleSerializer(many=True, read_only=True)
    profile_picture = serializers.ImageField(read_only=True)
    
    class Meta:
        model = User
        fields = ['id', 'first_name', 'last_name', 'email', 'phone_number', 'profile_picture', 'roles']


class UserDetailSerializer(serializers.ModelSerializer):
    roles = RoleSerializer(many=True)
    profile_picture = serializers.ImageField()

    class Meta:
        model = User
        fields = [
            'id',
            'username',
            'email',
            'date_joined',
            'first_name',
            'last_name',
            'phone_number',
            'address',
            'profile_picture',
            'roles',
            'is_active',
        ]
        read_only_fields = ['id', 'username', 'email', 'date_joined']

class UsernameCheckSerializer(serializers.Serializer):
    username_data = serializers.CharField(
        max_length=150,
        validators=[
            RegexValidator(
                regex=r'^[a-zA-Z0-9_\-\.]+$',  # Allows letters, digits, _, -, .
                message="Enter a valid username. Only letters, digits, -, _, and . are allowed."
            )
        ]
    )

    def validate_username_data(self, value):
        if User.objects.filter(username=value).exists():
            raise serializers.ValidationError("This username is already taken.")
        return value
    



class UserCreateSerializer(serializers.ModelSerializer):
    roles = serializers.PrimaryKeyRelatedField(
        queryset=Role.objects.all(),
        many=True,
        required=False
    )
    profile_picture = serializers.ImageField(required=False, allow_null=True)

    class Meta:
        model = User
        fields = [
            'username', 'email', 'first_name', 'last_name',
            'phone_number', 'address', 'profile_picture', 'roles'
        ]

    def to_internal_value(self, data):
        # Create a mutable copy of data
        mutable_data = {}
        for key, value in data.items():
            # Convert empty string or None for profile_picture to None
            if key == 'profile_picture' and (value == '' or value is None):
                mutable_data[key] = None
            else:
                mutable_data[key] = value

        if 'roles' in mutable_data:
            roles_data = mutable_data['roles']
            try:
                if isinstance(roles_data, str):
                    # Handle JSON string or comma-separated string
                    if roles_data.startswith('['):
                        roles_data = json.loads(roles_data)
                    else:
                        roles_data = roles_data.strip('[]"\'')
                        if ',' in roles_data:
                            roles_data = [role_id.strip(' "\'') for role_id in roles_data.split(',')]
                        else:
                            roles_data = [roles_data] if roles_data else []
                
                if isinstance(roles_data, list):
                    roles_data = [int(role_id) for role_id in roles_data if role_id]
                else:
                    raise ValueError("Roles must be a list of integers")
                
                mutable_data['roles'] = roles_data
            except (json.JSONDecodeError, ValueError, TypeError) as e:
                raise serializers.ValidationError({
                    "roles": "Invalid format for roles. Expected a list of integers."
                })

        return super().to_internal_value(mutable_data)

    def validate_username(self, value):
        if User.objects.filter(username=value).exists():
            raise serializers.ValidationError("This username is already taken.")
        return value

    def validate_email(self, value):
        if User.objects.filter(email=value).exists():
            raise serializers.ValidationError("This email is already registered.")
        return value

    def validate_profile_picture(self, value):
        # Explicitly validate that profile_picture is a file or None
        if value is not None and not hasattr(value, 'read'):
            raise serializers.ValidationError("Profile picture must be a valid image file.")
        return value

    def create(self, validated_data):
        roles_data = validated_data.pop('roles', [])
        profile_picture = validated_data.pop('profile_picture', None)

        user = User(**validated_data)
        user.save()

        if roles_data:
            user.roles.set(roles_data)

        if profile_picture:
            # Get the file extension
            ext = os.path.splitext(profile_picture.name)[1]
            # Generate a random 10-character filename
            random_name = uuid.uuid4().hex[:10]
            new_filename = f"{random_name}{ext}"

            # Save the file
            try:
                user.profile_picture.save(new_filename, profile_picture, save=True)
            except Exception as e:
                user.delete()  # Clean up the user if file saving fails
                raise serializers.ValidationError(f"Error saving profile picture: {str(e)}")

        return user
    

class UserUpdateSerializer(serializers.ModelSerializer):
    roles = serializers.PrimaryKeyRelatedField(
        queryset=Role.objects.all(),
        many=True,
        required=False
    )
    profile_picture = serializers.ImageField(required=False)

    class Meta:
        model = User
        fields = [
            'email', 'first_name', 'last_name',
            'phone_number', 'address', 'profile_picture', 'roles'
        ]

    def to_internal_value(self, data):
        # Create a mutable copy of data without deepcopying file objects
        mutable_data = {}
        for key, value in data.items():
            if key == 'profile_picture':
                # Pass the file object directly
                mutable_data[key] = value
            else:
                # Copy other fields
                mutable_data[key] = value

        if 'roles' in mutable_data:
            roles_data = mutable_data['roles']
            try:
                if isinstance(roles_data, str):
                    roles_data = roles_data.strip('[]"\'')
                    if ',' in roles_data:
                        roles_data = [role_id.strip(' "\'') for role_id in roles_data.split(',')]
                    else:
                        roles_data = [roles_data] if roles_data else []

                if isinstance(roles_data, list):
                    roles_data = [int(role_id) for role_id in roles_data if role_id]
                else:
                    raise ValueError("Roles must be a list of integers")

                mutable_data['roles'] = roles_data
            except (ValueError, TypeError):
                raise serializers.ValidationError({
                    "roles": "Invalid format for roles. Expected a list of integers."
                })

        return super().to_internal_value(mutable_data)

    def validate_email(self, value):
        user = self.instance  # The user being updated
        if User.objects.filter(email=value).exclude(pk=user.pk).exists():
            raise serializers.ValidationError("This email is already registered.")
        return value

    def update(self, instance, validated_data):
        instance.email = validated_data.get('email', instance.email)
        instance.first_name = validated_data.get('first_name', instance.first_name)
        instance.last_name = validated_data.get('last_name', instance.last_name)
        instance.phone_number = validated_data.get('phone_number', instance.phone_number)
        instance.address = validated_data.get('address', instance.address)

        profile_picture = validated_data.get('profile_picture')
        if profile_picture is not None:
            # Get the file extension
            ext = os.path.splitext(profile_picture.name)[1]
            # Generate a random 10-character filename
            random_name = uuid.uuid4().hex[:10]
            new_filename = f"{random_name}{ext}"
            
            # Save the file content
            instance.profile_picture.save(new_filename, profile_picture, save=True)

        if 'roles' in validated_data:
            instance.roles.set(validated_data['roles'])

        instance.save()
        return instance


class UserDeleteSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = []  # No fields needed for deletion
    
    def validate(self, attrs):
        user = self.instance
        request = self.context.get('request')
        
        # Prevent deletion of superusers
        if user.is_superuser:
            raise serializers.ValidationError("Superusers cannot be deleted.")
        
        # Prevent users from deleting themselves
        if request and user == request.user:
            raise serializers.ValidationError("You cannot delete your own account.")
        
        return attrs


class RoleCreateSerializer(serializers.ModelSerializer):
    permissions = serializers.PrimaryKeyRelatedField(
        many=True,
        queryset=Permission.objects.all(),
        required=False,
        default=[]
    )

    class Meta:
        model = Role
        fields = ['id', 'name', 'description', 'permissions']
        extra_kwargs = {
            'name': {
                'required': True,
                'error_messages': {
                    'blank': 'Role name cannot be empty.',
                    'required': 'Role name is required.'
                }
            },
            'description': {
                'required': False,
                'allow_blank': True
            }
        }

    def validate_name(self, value):
        """Case-insensitive unique name validation"""
        if Role.objects.filter(name__iexact=value).exists():
            raise serializers.ValidationError("A role with this name already exists.")
        return value.strip()

    def create(self, validated_data):
        """Handle role creation with permissions"""
        permissions = validated_data.pop('permissions')
        role = Role.objects.create(**validated_data)
        role.permissions.set(permissions)
        return role
    


class RoleDeleteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Role
        fields = []  # No fields needed for deletion
    
    def validate(self, attrs):
        role = self.instance
        
        # 1. Validate role exists
        if not role:
            raise serializers.ValidationError("Role does not exist.")
        
        # 2. Prevent deletion of protected roles (e.g., 'admin')
        protected_roles = ['admin', 'superuser']  # Add other protected roles as needed
        if role.name.lower() in [r.lower() for r in protected_roles]:
            raise serializers.ValidationError(
                f"Cannot delete protected role: {role.name}"
            )
            
        return attrs
    
class RoleUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Role
        fields = ['id', 'name', 'description', 'permissions']
        extra_kwargs = {
            'name': {
                'required': True,
                'error_messages': {
                    'blank': 'Role name cannot be empty.',
                    'required': 'Role name is required.'
                }
            },
            'description': {
                'required': False,
                'allow_blank': True
            }
        }

    def validate_name(self, value):
        """Case-insensitive unique name validation, excluding current instance for updates"""
        instance = self.instance
        queryset = Role.objects.filter(name__iexact=value)
        if instance:
            queryset = queryset.exclude(id=instance.id)
        if queryset.exists():
            raise serializers.ValidationError("A role with this name already exists.")
        return value.strip()

    def to_internal_value(self, data):
        """Handle permissions submitted as dictionaries with IDs"""
        mutable_data = data.copy() if hasattr(data, 'copy') else dict(data)
        
        # Extract IDs from permission dictionaries if present
        if 'permissions' in mutable_data and isinstance(mutable_data['permissions'], list):
            permission_ids = []
            for perm in mutable_data['permissions']:
                if isinstance(perm, dict) and 'id' in perm:
                    permission_ids.append(perm['id'])
                else:
                    permission_ids.append(perm)
            mutable_data['permissions'] = permission_ids
            
        return super().to_internal_value(mutable_data)
    

class PasswordChangeSerializer(serializers.Serializer):
    new_password = serializers.CharField(required=True)
    confirm_password = serializers.CharField(required=True)

    def validate(self, data):
        if data['new_password'] != data['confirm_password']:
            raise serializers.ValidationError("The two password fields didn't match.")
        return data

    def save(self, **kwargs):
        user = self.context['request'].user
        user.password = make_password(self.validated_data['new_password'])
        user.is_new = False
        user.save()
        return user
    

class SendOTPSerializer(serializers.Serializer):
    email = serializers.EmailField(required=True)


class RecordSerializer(serializers.Serializer):
    channel = serializers.IntegerField(default=1)
    filename = serializers.CharField(max_length=255)

class StopRecordSerializer(serializers.Serializer):
    channel = serializers.IntegerField(default=1)
    filename = serializers.CharField(max_length=255)

class RecordServerMinimalSerializer(serializers.ModelSerializer):
    """
    Minimal server serializer to provide context for the port.
    """
    class Meta:
        model = RecordServer
        fields = ['id', 'name', 'ip_address', 'is_active']


class RecordPortStatusSerializer(serializers.ModelSerializer):
    # Nesting the server details to make the API output meaningful
    server = RecordServerMinimalSerializer(read_only=True)
    
    # Explicitly exposing the string representation for ease of use in UI dropdowns
    display_name = serializers.CharField(source='__str__', read_only=True)

    class Meta:
        model = RecordPort
        fields = [
            'id', 
            'server', 
            'channel_index', 
            'name', 
            'display_name', 
            'is_recording'
        ]


class RecordingCRUDSerializer(serializers.ModelSerializer):
    # Expose duration as a read-only field since it's a model property
    duration = serializers.SerializerMethodField()

    class Meta:
        model = Recording
        fields = [
            'id', 
            'port', 
            'filename', 
            'filepath', 
            'start_time', 
            'end_time', 
            'file_size', 
            'status', 
            'processing_status',
            'duration',
            'note'
        ]
        
    def get_duration(self, obj):
        # Converts timedelta to string format (e.g., "01:30:00")
        return str(obj.duration)