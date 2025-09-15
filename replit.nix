{ pkgs }: {
  deps = [
    pkgs.nodejs-18_x
    pkgs.nodePackages.npm
    pkgs.imagemagick
    pkgs.ffmpeg
  ];
}
