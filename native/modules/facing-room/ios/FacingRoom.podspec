Pod::Spec.new do |s|
  s.name           = 'FacingRoom'
  s.version        = '1.0.0'
  s.summary        = 'Reads a presenter\'s head direction from a recorded video for Rabbithole'
  s.description    = 'A local Expo module that runs Apple Vision face detection over a recorded video a few frames a second and returns head turn and tilt, so audience mode can mark when a presenter turned away from the room.'
  s.author         = 'Rabbithole'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.frameworks = 'AVFoundation', 'CoreMedia', 'Vision'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
