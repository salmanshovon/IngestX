from django.contrib import admin
from django.utils.html import format_html
from .models import RecordServer, RecordPort, Recording, RecordLog

@admin.register(RecordServer)
class RecordServerAdmin(admin.ModelAdmin):
    list_display = ('name', 'ip_address', 'is_active')
    list_filter = ('is_active',)
    search_fields = ('name', 'ip_address') # Enables autocomplete_fields safely for RecordPort
    
    fieldsets = (
        (None, {
            'fields': ('name', 'is_active')
        }),
        ('Connection Details', {
            'fields': ('ip_address', 'storage_path'),
            'description': 'Network and filesystem configuration for the recording node.'
        }),
    )


@admin.register(RecordPort)
class RecordPortAdmin(admin.ModelAdmin):
    list_display = ('name', 'server', 'channel_index', 'recording_indicator')
    list_filter = ('server', 'is_recording')
    search_fields = ('name', 'server__name')
    autocomplete_fields = ['server']

    @admin.display(description="Recording State")
    def recording_indicator(self, obj):
        if obj.is_recording:
            return format_html(
                '<span style="color: #d9534f; font-weight: bold;">● RECORDING</span>'
            )
        return format_html('<span style="color: #5cb85c;">○ IDLE</span>')


@admin.register(Recording)
class RecordingAdmin(admin.ModelAdmin):
    list_display = (
        'filename', 
        'port_link', 
        'status_tag', 
        'start_time', 
        'end_time',  # Optional: added to the list view for visibility
        'formatted_duration', 
        'human_file_size'
    )
    list_filter = ('status', 'start_time', 'port__server', 'port')
    search_fields = ('filename', 'filepath')
    
    # REMOVED both 'start_time' and 'end_time' from here so they are editable
    readonly_fields = ('file_size', 'formatted_duration') 
    date_hierarchy = 'start_time'

    def port_link(self, obj):
        if obj.port:
            return f"{obj.port.server.name} [CH {obj.port.channel_index}]"
        return "-"
    port_link.short_description = "Source Port"

    @admin.display(description="Status")
    def status_tag(self, obj):
        colors = {
            'SCHEDULED': "#abb2b9",
            'RECORDING': '#007bff',
            'COMPLETED': '#28a745',
            'FAILED': '#dc3545',
            'STOPPED': '#ffc107',
        }
        return format_html(
            '<strong style="color: {};">{}</strong>',
            colors.get(obj.status, '#000'),
            obj.get_status_display()
        )

    @admin.display(description="Duration")
    def formatted_duration(self, obj):
        d = obj.duration
        if d.total_seconds() <= 0:
            return "00:00:00"
            
        hours, remainder = divmod(d.total_seconds(), 3600)
        minutes, seconds = divmod(remainder, 60)
        return f"{int(hours):02}:{int(minutes):02}:{int(seconds):02}"

    @admin.display(description="Size")
    def human_file_size(self, obj):
        size = obj.file_size
        for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
            if size < 1024:
                return f"{size:.2f} {unit}"
            size /= 1024
        return f"{size:.2f} PB"

@admin.register(RecordLog)
class RecordLogAdmin(admin.ModelAdmin):
    list_display = ('timestamp', 'recording_link', 'event_type', 'message_snippet')
    list_filter = ('event_type', 'timestamp')
    search_fields = ('message', 'recording__filename')
    readonly_fields = ('timestamp',)
    date_hierarchy = 'timestamp'

    def recording_link(self, obj):
        if obj.recording:
            return obj.recording.filename
        return "System Event (No Recording)"
    recording_link.short_description = "Associated Recording"

    @admin.display(description="Message")
    def message_snippet(self, obj):
        """Truncates logs so long error stack traces don't ruin the list view grid"""
        if len(obj.message) > 80:
            return f"{obj.message[:80]}..."
        return obj.message