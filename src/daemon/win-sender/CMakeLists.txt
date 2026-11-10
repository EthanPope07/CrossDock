cmake_minimum_required(VERSION 3.20)
project(win_sender CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_executable(win-sender src/main.cpp)
target_compile_definitions(win-sender PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
target_compile_options(win-sender PRIVATE -Wall -Wextra)
target_link_libraries(win-sender PRIVATE ws2_32 shell32 winmm)
# Static runtime so the exe has no MSYS2 DLL dependencies.
target_link_options(win-sender PRIVATE -static)
