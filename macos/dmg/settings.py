import subprocess
from pathlib import Path
application = Path(defines['app']).resolve()
assets = Path(defines['assets']).resolve()
if not application.is_dir() or application.suffix != '.app':
    raise ValueError('app must be an existing .app bundle')
appname = application.name
format = 'UDZO'
filesystem = 'HFS+'
files = [str(application)]
symlinks = {'Applications': '/Applications'}
icon = str(application / 'Contents/Resources/icon.icns')
hide_extensions = []
background = str(assets / 'background.tiff')
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
window_rect = ((200, 160), (800, 560))
default_view = 'icon-view'
include_icon_view_settings = True
include_list_view_settings = False
arrange_by = None
icon_size = 96
text_size = 13
label_pos = 'bottom'
icon_locations = {appname: (190, 250), 'Applications': (600, 250)}


def create_hook(mount_point, options):
    # Packaging must preserve the signed app, including its metadata.
    subprocess.run(
        ['codesign', '--verify', '--deep', '--strict',
         str(Path(mount_point) / appname)], check=True,
    )
