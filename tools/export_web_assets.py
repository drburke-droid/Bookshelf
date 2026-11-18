"""Export the decorations in bookshelf_template.blend as .glb files for the website.

    blender -b bookshelf_template.blend --python tools/export_web_assets.py -- docs/assets/props
"""
import os
import sys

import bpy

out_dir = os.path.abspath(sys.argv[sys.argv.index("--") + 1])
os.makedirs(out_dir, exist_ok=True)
scene = bpy.context.scene
props = bpy.data.collections["Bookshelf Props"]

for coll in props.children:
    for ob in scene.objects:
        ob.select_set(False)
    linked = []
    for ob in coll.objects:
        scene.collection.objects.link(ob)      # the props collection is hidden from the view layer
        linked.append(ob)
    bpy.context.view_layer.update()
    for ob in linked:
        ob.select_set(True)
    name = coll.name.lower().replace(" ", "_")
    path = os.path.join(out_dir, name + ".glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_image_format="JPEG", export_jpeg_quality=85,
                              export_yup=True, export_apply=True)
    for ob in linked:
        scene.collection.objects.unlink(ob)
    print(f"EXPORTED {name}.glb {os.path.getsize(path) / 1e6:.2f} MB")
