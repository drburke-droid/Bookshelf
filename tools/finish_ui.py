"""Optional last step for the template: open the Bookshelf tab and fit the camera view, then save.

These two things can only be set with a window open, so run this without -b:

    blender --enable-autoexec bookshelf_template.blend --python tools/finish_ui.py
"""
import bpy


def finish():
    window = bpy.context.window_manager.windows[0]
    for area in window.screen.areas:
        if area.type != "VIEW_3D":
            continue
        for region in area.regions:
            if region.type == "UI":
                region.active_panel_category = "Bookshelf"
        main = next(region for region in area.regions if region.type == "WINDOW")
        with bpy.context.temp_override(window=window, area=area, region=main):
            bpy.ops.view3d.view_center_camera()
    bpy.ops.wm.save_mainfile(compress=True)
    print("FINISHED UI", bpy.data.filepath)
    bpy.app.timers.register(lambda: bpy.ops.wm.quit_blender() and None, first_interval=1.0)
    return None


bpy.app.timers.register(finish, first_interval=4.0)
