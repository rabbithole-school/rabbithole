Pod::Spec.new do |s|
  s.name           = 'CommandTextInput'
  s.version        = '1.0.0'
  s.summary        = 'Scoped multiline editor with hardware-keyboard commands'
  s.description    = 'A local Expo view whose UITextView owns Escape and Command-Enter handling without process-wide hooks or a second focus system.'
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

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
