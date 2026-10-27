from django.db import models
from django.contrib.auth.models import AbstractUser, Permission, Group
from django.db.models.signals import post_save, m2m_changed
from django.dispatch import receiver


class User(AbstractUser):
    email = models.EmailField(unique=True, db_index=True)
    phone_number = models.CharField(max_length=15)
    address = models.TextField(null=True, blank=True)
    profile_picture = models.ImageField(upload_to='profile_pictures/', null=True, blank=True)
    roles = models.ManyToManyField('Role', related_name='users', blank=True)
    department = models.ForeignKey('Department', on_delete=models.SET_NULL, null=True, blank=True, 
                                  related_name='department_members')
    is_new = models.BooleanField(default=True)
    otp = models.IntegerField(null=True, blank=True)
    is_cadet = models.BooleanField(default=False)
    is_teacher = models.BooleanField(default=False)
    
    class Meta:
        indexes = [
            models.Index(fields=['department']),
            models.Index(fields=['last_name', 'first_name']),
        ]
    
    def __str__(self):
        roles_str = ', '.join(role.name for role in self.roles.all()) if self.roles.exists() else 'No Roles'
        return f"{self.first_name} {self.last_name} ({roles_str})"
    
    def get_department_code(self):
        return self.department.code if self.department else None


class Role(models.Model):
    name = models.CharField(max_length=100)
    group = models.OneToOneField(Group, on_delete=models.CASCADE, related_name='role', null=True, blank=True)
    permissions = models.ManyToManyField(Permission)
    description = models.TextField()

    def __str__(self):
        return self.name



class Department(models.Model):
    name = models.CharField(max_length=100, db_index=True)
    code = models.CharField(max_length=10, unique=True, db_index=True)
    description = models.TextField()
    head = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, related_name='department_head')
    parent_department = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='sub_departments')
    is_active = models.BooleanField(default=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=['name', 'code']),
        ]
        ordering = ['name']

    def __str__(self):
        return f"{self.code} - {self.name}"


@receiver(post_save, sender=Role)
def create_or_update_role_group(sender, instance, created, **kwargs):
    """
    Create or update the corresponding Group for a Role and sync permissions.
    """
    if created or not instance.group:
        # Create a new Group if the Role is new or has no Group
        group, _ = Group.objects.get_or_create(name=instance.name)
        instance.group = group
        instance.save()
    # Sync permissions from Role to Group
    instance.group.permissions.set(instance.permissions.all())

@receiver(m2m_changed, sender=Role.permissions.through)
def sync_role_permissions(sender, instance, action, **kwargs):
    """
    Sync Role.permissions with Role.group.permissions when permissions change.
    """
    if action in ["post_add", "post_remove", "post_clear"] and instance.group:
        instance.group.permissions.set(instance.permissions.all())

@receiver(m2m_changed, sender=User.roles.through)
def update_user_groups(sender, instance, action, **kwargs):
    """
    Sync User.roles with User.groups when roles change.
    """
    if action in ["post_add", "post_remove", "post_clear"]:
        # Get groups corresponding to the user's roles
        groups = Group.objects.filter(role__users=instance)
        # Update user's groups
        instance.groups.set(groups)